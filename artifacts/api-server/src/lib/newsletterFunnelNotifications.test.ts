import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, mock, test } from "node:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  getCoverageRegressionAlertKey,
  notifyNewsletterCoverageRegressions,
  type NewsletterFunnelNotificationDependencies,
} from "./newsletterFunnelNotifications";
import type { NewsletterFunnelReport } from "./newsletterFunnelAnalytics";
import {
  analyticsCoverageAlertsTable,
  db,
  pool,
} from "@workspace/db";

function report(
  alerts: NewsletterFunnelReport["coverage"]["alerts"],
  regressionCohort = "2026-08-03",
): NewsletterFunnelReport {
  return {
    reportAsOf: "September 11, 2026 (UTC)",
    coverage: {
      startDate: "2026-06-29",
      status: "recorded",
      auditTrail: [],
      cohorts: [
        {
          cohort: "2026-07-27",
          coverageStatus: "covered",
          requests: 100,
        },
        {
          cohort: regressionCohort,
          coverageStatus: "zero_requests",
          requests: 0,
        },
        {
          cohort: "2026-08-10",
          coverageStatus: "zero_requests",
          requests: 0,
        },
      ],
      alerts,
    },
    native: {
      rows: [],
      comparison: {
        result: "Inconclusive",
        liftPoints: null,
        liftCi95LowerPoints: null,
        liftCi95UpperPoints: null,
      },
    },
    historical: { rows: [] },
  };
}

type CoverageAlertWorkerMode = "race" | "independent" | "restart" | "crash-before-send" | "paused-recovery";
const CRASH_BEFORE_SEND_EXIT_CODE = 73;

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out waiting for coverage alert worker barrier");
}

async function runCoverageAlertWorker(): Promise<void> {
  const mode = process.env.COVERAGE_ALERT_WORKER_MODE;
  if (mode !== "race" && mode !== "independent" && mode !== "restart" && mode !== "crash-before-send" && mode !== "paused-recovery") {
    throw new Error("Missing coverage alert worker mode");
  }

  const cohort = process.env.COVERAGE_ALERT_WORKER_COHORT;
  if (!cohort) throw new Error("Missing coverage alert worker cohort");

  const readyFile = process.env.COVERAGE_ALERT_WORKER_READY_FILE;
  const peerReadyFile = process.env.COVERAGE_ALERT_WORKER_PEER_READY_FILE;
  if (mode === "race" || mode === "independent") {
    if (!readyFile || !peerReadyFile) {
      throw new Error("Missing coverage alert worker barrier paths");
    }
    await writeFile(readyFile, "");
    await waitForFile(peerReadyFile);
  }

  let sends = 0;
  let fallbackSends = 0;
  if (mode === "paused-recovery") {
    if (!readyFile || !peerReadyFile) {
      throw new Error("Missing paused recovery worker barrier paths");
    }
    const query = pool.query;
    let paused = false;
    mock.method(pool, "query", async (...args: unknown[]) => {
      const result = await Reflect.apply(query, pool, args);
      const config = args[0] as { text?: string } | string;
      const text = typeof config === "string" ? config : config.text;
      if (!paused && text?.startsWith('update "analytics_coverage_alerts" set "claimed_at"')) {
        assert.equal(result.rows.length, 1, "old worker must reclaim the fixture");
        paused = true;
        // The real renewal has committed. Delay returning its ID to the real
        // notifier, without replacing its durable delivery CAS or sent write.
        await writeFile(readyFile, "");
        await waitForFile(peerReadyFile);
      }
      return result;
    });
  }
  try {
    const delivered = await notifyNewsletterCoverageRegressions(
      report([{ kind: "coverage_regression", cohorts: [cohort] }], cohort),
      {
        ...(mode === "independent" || mode === "paused-recovery" ? {
          sendFallbackAlert: async () => {
            fallbackSends += 1;
            throw new Error("This worker must not use email fallback");
          },
        } : {}),
        ...(mode === "crash-before-send" ? {
          startAlertDelivery: async (): Promise<boolean> => {
            // The claim committed, but the durable delivery boundary has not.
            process.exit(CRASH_BEFORE_SEND_EXIT_CODE);
          },
        } : {}),
        sendAlert: async () => {
          sends += 1;
          if (mode === "paused-recovery") {
            // Force fallback too if the stale worker incorrectly reaches send.
            throw new Error("A stale claimant must not contact Slack");
          }
          if (mode === "independent") {
            // Neither send may finish until the other key also reaches delivery.
            // This catches global serialization as well as cross-key suppression.
            await writeFile(`${readyFile}.sending`, "");
            await waitForFile(`${peerReadyFile}.sending`);
          }
        },
      },
    );
    process.stdout.write(JSON.stringify({
      delivered,
      sends,
      ...(mode === "independent" || mode === "paused-recovery" ? { fallbackSends } : {}),
    }));
  } finally {
    mock.restoreAll();
    await pool.end();
  }
}

type CoverageAlertWorkerResult = {
  delivered: boolean;
  sends: number;
  fallbackSends?: number;
};

function startCoverageAlertWorker(
  mode: CoverageAlertWorkerMode,
  cohort: string,
  barrier?: { readyFile: string; peerReadyFile: string },
): Promise<CoverageAlertWorkerResult> {
  const workerEnvironment = { ...process.env };
  delete workerEnvironment.NODE_TEST_CONTEXT;
  workerEnvironment.COVERAGE_ALERT_WORKER_MODE = mode;
  workerEnvironment.COVERAGE_ALERT_WORKER_COHORT = cohort;
  if (barrier) {
    workerEnvironment.COVERAGE_ALERT_WORKER_READY_FILE = barrier.readyFile;
    workerEnvironment.COVERAGE_ALERT_WORKER_PEER_READY_FILE =
      barrier.peerReadyFile;
  }

  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: workerEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("close", (code) => {
      const expectedCode = mode === "crash-before-send"
        ? CRASH_BEFORE_SEND_EXIT_CODE
        : 0;
      if (code !== expectedCode) {
        reject(
          new Error(
            `Coverage alert worker exited with code ${code}: ${stderr || stdout}`,
          ),
        );
        return;
      }
      if (mode === "crash-before-send") {
        resolve({ delivered: false, sends: 0 });
        return;
      }
      try {
        resolve(JSON.parse(stdout) as CoverageAlertWorkerResult);
      } catch (error) {
        reject(
          new Error(`Coverage alert worker returned invalid output: ${stdout}`, {
            cause: error,
          }),
        );
      }
    });
  });
}

const workerMode = process.env.COVERAGE_ALERT_WORKER_MODE;
if (workerMode) {
  await runCoverageAlertWorker();
} else {
  after(async () => {
    await pool.end();
  });
}

if (!workerMode) {
  test("sends one aggregate-only notification for a new coverage regression", async () => {
    const sent: unknown[] = [];
    let fallbackSends = 0;
    const dependencies: NewsletterFunnelNotificationDependencies = {
      claimAlert: async () => 42,
      startAlertDelivery: async () => true,
      markAlertSent: async (id) => assert.equal(id, 42),
      releaseAlert: async () => assert.fail("successful sends are not released"),
      sendAlert: async (alert) => {
        sent.push(alert);
      },
      sendFallbackAlert: async () => {
        fallbackSends += 1;
      },
    };

    assert.equal(
      await notifyNewsletterCoverageRegressions(
        report([
          { kind: "missing_events", cohorts: ["2026-08-03"] },
          { kind: "coverage_regression", cohorts: ["2026-08-03", "2026-08-10"] },
        ]),
        dependencies,
      ),
      true,
    );
    assert.deepEqual(sent, [
      {
        cohorts: [
          { cohort: "2026-08-03", requests: 0 },
          { cohort: "2026-08-10", requests: 0 },
        ],
      },
    ]);
    assert.equal(fallbackSends, 0);
    assert.equal(
      JSON.stringify(sent).match(
        /\b(session_id|subscriber_id|email|token|url_query|subscriber_email)\b/i,
      ),
      null,
    );
  });

  test("does not send when another worker already claimed the alert", async () => {
    let sends = 0;
    const dependencies: NewsletterFunnelNotificationDependencies = {
      claimAlert: async () => null,
      sendAlert: async () => {
        sends += 1;
      },
    };

    assert.equal(
      await notifyNewsletterCoverageRegressions(
        report([{ kind: "coverage_regression", cohorts: ["2026-08-03"] }]),
        dependencies,
      ),
      false,
    );
    assert.equal(sends, 0);
  });

  test("uses Resend after Slack fails, reusing the aggregate alert and delivery identity", async () => {
    const channelCalls: Array<{
      channel: "slack" | "resend";
      alert: unknown;
      idempotencyKey: string;
    }> = [];
    let markedSent = false;
    const dependencies: NewsletterFunnelNotificationDependencies = {
      claimAlert: async () => 7,
      startAlertDelivery: async () => true,
      markAlertSent: async (id) => {
        assert.equal(id, 7);
        markedSent = true;
      },
      releaseAlert: async () => assert.fail("delivered alerts are not released"),
      sendAlert: async (alert, idempotencyKey) => {
        channelCalls.push({ channel: "slack", alert, idempotencyKey });
        throw new Error("Slack unavailable");
      },
      sendFallbackAlert: async (alert, idempotencyKey) => {
        channelCalls.push({ channel: "resend", alert, idempotencyKey });
      },
    };

    assert.equal(
      await notifyNewsletterCoverageRegressions(
        report([{ kind: "coverage_regression", cohorts: ["2026-08-03"] }]),
        dependencies,
      ),
      true,
    );
    assert.equal(markedSent, true);
    assert.deepEqual(
      channelCalls.map(({ channel }) => channel),
      ["slack", "resend"],
    );
    assert.deepEqual(channelCalls[0]?.alert, {
      cohorts: [{ cohort: "2026-08-03", requests: 0 }],
    });
    assert.deepEqual(channelCalls[1]?.alert, channelCalls[0]?.alert);
    assert.equal(
      channelCalls[1]?.idempotencyKey,
      channelCalls[0]?.idempotencyKey,
    );
    assert.match(
      channelCalls[0]?.idempotencyKey ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("keeps provider failures non-blocking and releases an undelivered claim", async () => {
    let releasedId: number | null = null;
    let fallbackAttempts = 0;
    const providerFailures: string[] = [];
    const dependencies: NewsletterFunnelNotificationDependencies = {
      claimAlert: async () => 7,
      startAlertDelivery: async () => true,
      releaseAlert: async (id) => {
        releasedId = id;
      },
      sendAlert: async () => {
        throw new Error("Slack unavailable");
      },
      sendFallbackAlert: async () => {
        fallbackAttempts += 1;
        throw new Error("Resend unavailable");
      },
      onProviderFailure: (channel) => providerFailures.push(channel),
    };

    assert.equal(
      await notifyNewsletterCoverageRegressions(
        report([{ kind: "coverage_regression", cohorts: ["2026-08-03"] }]),
        dependencies,
      ),
      false,
    );
    assert.equal(fallbackAttempts, 1);
    assert.equal(releasedId, 7);
    assert.deepEqual(providerFailures, ["Slack", "Resend"]);
  });

  for (const acceptedChannel of ["Slack", "Resend"] as const) {
    test(`${acceptedChannel} acceptance survives a failed sent write and recovery in a fresh process`, async () => {
      const cohort = `accepted-write-failure-${randomUUID()}`;
      const alertKey = getCoverageRegressionAlertKey({ cohorts: [{ cohort, requests: 0 }] });
      const input = report([{ kind: "coverage_regression", cohorts: [cohort] }], cohort);
      let slackSends = 0;
      let fallbackSends = 0;
      try {
        await assert.rejects(notifyNewsletterCoverageRegressions(input, {
          sendAlert: async () => {
            slackSends += 1;
            if (acceptedChannel === "Resend") throw new Error("Slack rejected");
          },
          sendFallbackAlert: async () => { fallbackSends += 1; },
          markAlertSent: async () => { throw new Error("sent status persistence failed"); },
          releaseAlert: async () => assert.fail("accepted delivery must not be released"),
        }), /sent status persistence failed/);
        assert.equal(slackSends, 1);
        assert.equal(fallbackSends, acceptedChannel === "Resend" ? 1 : 0);
        const [held] = await db.select().from(analyticsCoverageAlertsTable)
          .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
        assert.ok(held?.deliveryStartedAt, "persist the delivery hold before contacting Slack");
        assert.equal(held.sentAt, null);
        await db.update(analyticsCoverageAlertsTable)
          .set({ claimedAt: sql`CURRENT_TIMESTAMP - interval '2 days'` })
          .where(eq(analyticsCoverageAlertsTable.id, held.id));

        assert.deepEqual(await startCoverageAlertWorker("restart", cohort), {
          delivered: false, sends: 0,
        }, "lease expiry and loss of process memory must not resend an accepted alert");
        assert.equal(await notifyNewsletterCoverageRegressions(input, {
          claimAlert: async () => held.id,
          sendAlert: async () => assert.fail("delivery boundary must reject stale claimants"),
          sendFallbackAlert: async () => assert.fail("no duplicate fallback"),
        }), false);
      } finally {
        await db.delete(analyticsCoverageAlertsTable)
          .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
      }
    });
  }

  test("failed providers release the durable hold so a fresh process can retry", async () => {
    const cohort = `rejected-retry-${randomUUID()}`;
    const alertKey = getCoverageRegressionAlertKey({ cohorts: [{ cohort, requests: 0 }] });
    try {
      assert.equal(await notifyNewsletterCoverageRegressions(
        report([{ kind: "coverage_regression", cohorts: [cohort] }], cohort),
        {
          sendAlert: async () => { throw new Error("Slack rejected"); },
          sendFallbackAlert: async () => { throw new Error("Resend rejected"); },
          markAlertSent: async () => assert.fail("rejected alerts are not sent"),
        },
      ), false);
      assert.deepEqual(await db.select().from(analyticsCoverageAlertsTable)
        .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey)), []);
      assert.deepEqual(await startCoverageAlertWorker("restart", cohort), {
        delivered: true, sends: 1,
      });
      assert.deepEqual(await startCoverageAlertWorker("restart", cohort), {
        delivered: false, sends: 0,
      });
    } finally {
      await db.delete(analyticsCoverageAlertsTable)
        .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
    }
  });

  test("a failed delivery-boundary write never contacts providers or releases the claim", async () => {
    await assert.rejects(notifyNewsletterCoverageRegressions(
      report([{ kind: "coverage_regression", cohorts: ["2026-08-03"] }]),
      {
        claimAlert: async () => 42,
        startAlertDelivery: async () => { throw new Error("database unavailable"); },
        sendAlert: async () => assert.fail("must persist boundary first"),
        sendFallbackAlert: async () => assert.fail("must persist boundary first"),
        releaseAlert: async () => assert.fail("write may have committed"),
      },
    ), /database unavailable/);
  });

  test("a slow recovery clock cannot make its active lease reclaimable by another process", async (t) => {
    const cohort = `slow-clock-${randomUUID()}`;
    const alertKey = getCoverageRegressionAlertKey({
      cohorts: [{ cohort, requests: 0 }],
    });
    const [fixture] = await db.insert(analyticsCoverageAlertsTable).values({
      alertKey,
      kind: "coverage_regression",
      cohortDates: [cohort],
      claimedAt: sql`CURRENT_TIMESTAMP - interval '11 minutes'`,
    }).returning();
    const [clock] = await db.select({
      now: sql<Date>`CURRENT_TIMESTAMP`.mapWith(analyticsCoverageAlertsTable.claimedAt),
    }).from(analyticsCoverageAlertsTable)
      .where(eq(analyticsCoverageAlertsTable.id, fixture!.id));
    // Mock only Date, not timers: the competing process and database retain
    // their own clocks, and barriers do not depend on a real lease-duration wait.
    t.mock.timers.enable({ apis: ["Date"], now: clock!.now.getTime() - 60 * 60_000 });
    let signalClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { signalClaimed = resolve; });
    let resume!: () => void;
    const resumeDelivery = new Promise<void>((resolve) => { resume = resolve; });
    let sends = 0;
    const recovery = notifyNewsletterCoverageRegressions(
      report([{ kind: "coverage_regression", cohorts: [cohort] }], cohort),
      {
        startAlertDelivery: async () => {
          // Hold precisely after renewal, before the durable delivery boundary
          // can mask a broken lease. Provider delivery remains entirely stubbed.
          signalClaimed();
          await resumeDelivery;
          return true;
        },
        sendAlert: async () => { sends += 1; },
      },
    );
    try {
      // Surface a recovery error rather than waiting forever for its barrier.
      await Promise.race([claimed, recovery.then(() => {
        throw new Error("Recovery finished before reaching the claim barrier");
      })]);
      const [renewed] = await db.select().from(analyticsCoverageAlertsTable)
        .where(eq(analyticsCoverageAlertsTable.id, fixture!.id));
      assert.equal(renewed!.deliveryStartedAt, null);
      assert.equal(renewed!.sentAt, null);
      const competitor = await startCoverageAlertWorker("restart", cohort);
      assert.deepEqual(competitor, { delivered: false, sends: 0 },
        "another process must not reclaim the slow worker's active lease");
      const [unchanged] = await db.select().from(analyticsCoverageAlertsTable)
        .where(eq(analyticsCoverageAlertsTable.id, fixture!.id));
      assert.deepEqual(unchanged, renewed, "blocked worker must not mutate the lease");
      assert.ok(renewed!.claimedAt.getTime() >= clock!.now.getTime(),
        "renewal must use database time, not the slow application clock");
      resume();
      assert.equal(await recovery, true);
      assert.equal(sends, 1);
      const [sent] = await db.select().from(analyticsCoverageAlertsTable)
        .where(eq(analyticsCoverageAlertsTable.id, fixture!.id));
      assert.ok(sent!.sentAt);
    } finally {
      resume();
      await recovery.catch(() => {});
      t.mock.timers.reset();
      await db.delete(analyticsCoverageAlertsTable)
        .where(eq(analyticsCoverageAlertsTable.id, fixture!.id));
    }
  });

  test("a paused recovery claimant cannot resend or mutate an alert completed by a fresh process", async () => {
    const cohort = `paused-recovery-${randomUUID()}`;
    const alertKey = getCoverageRegressionAlertKey({
      cohorts: [{ cohort, requests: 0 }],
    });
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "coverage-alert-paused-recovery-"),
    );
    const readyFile = path.join(temporaryDirectory, "claimed");
    const resumeFile = path.join(temporaryDirectory, "resume");
    const readClaim = () => db.select().from(analyticsCoverageAlertsTable)
      .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
    let staleWorker: Promise<CoverageAlertWorkerResult> | undefined;
    try {
      const [fixture] = await db.insert(analyticsCoverageAlertsTable).values({
        alertKey,
        kind: "coverage_regression",
        cohortDates: [cohort],
        claimedAt: sql`CURRENT_TIMESTAMP - interval '11 minutes'`,
      }).returning();
      staleWorker = startCoverageAlertWorker("paused-recovery", cohort, {
        readyFile,
        peerReadyFile: resumeFile,
      });
      await Promise.race([
        waitForFile(readyFile),
        staleWorker.then(() => {
          throw new Error("Stale worker exited before its claim barrier");
        }),
      ]);
      const [claimed] = await readClaim();
      assert.equal(claimed!.id, fixture!.id);
      assert.ok(claimed!.claimedAt > fixture!.claimedAt);
      assert.equal(claimed!.deliveryStartedAt, null);
      assert.equal(claimed!.sentAt, null);

      await db.update(analyticsCoverageAlertsTable)
        .set({ claimedAt: sql`CURRENT_TIMESTAMP - interval '11 minutes'` })
        .where(eq(analyticsCoverageAlertsTable.id, fixture!.id));
      const [expired] = await readClaim();
      assert.deepEqual(await startCoverageAlertWorker("restart", cohort), {
        delivered: true, sends: 1,
      }, "a fresh process must reclaim and finish while the old worker is paused");
      const completed = await readClaim();
      assert.equal(completed.length, 1);
      assert.equal(completed[0]!.id, fixture!.id);
      assert.ok(completed[0]!.claimedAt > expired!.claimedAt);
      assert.ok(completed[0]!.deliveryStartedAt);
      assert.ok(completed[0]!.sentAt);

      await writeFile(resumeFile, "");
      assert.deepEqual(await staleWorker, {
        delivered: false, sends: 0, fallbackSends: 0,
      }, "the resumed claimant must contact neither Slack nor Resend");
      assert.deepEqual(await readClaim(), completed,
        "the resumed claimant must not delete or change any completed row field");
    } finally {
      try {
        // Settle the child even if a barrier or assertion failed before release.
        try {
          await writeFile(resumeFile, "");
        } finally {
          await staleWorker?.catch(() => {});
        }
      } finally {
        try {
          await db.delete(analyticsCoverageAlertsTable)
            .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true });
        }
      }
    }
  });

  test("independent API processes race to recover an unsent claim only after its lease expires", async () => {
    // An isolated synthetic cohort keeps this fixture separate from real alerts
    // and from concurrent runs, without deleting any pre-existing records.
    const cohort = `crash-recovery-${randomUUID()}`;
    const alertKey = getCoverageRegressionAlertKey({
      cohorts: [{ cohort, requests: 0 }],
    });
    const readClaim = () => db
      .select()
      .from(analyticsCoverageAlertsTable)
      .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "coverage-alert-recovery-"),
    );

    try {
      await startCoverageAlertWorker("crash-before-send", cohort);
      const abandonedRows = await readClaim();
      assert.equal(abandonedRows.length, 1);
      const abandoned = abandonedRows[0]!;
      assert.equal(abandoned.sentAt, null);
      assert.equal(abandoned.deliveryStartedAt, null);
      assert.ok(abandoned.claimedAt);

      assert.deepEqual(await startCoverageAlertWorker("restart", cohort), {
        delivered: false,
        sends: 0,
      }, "an active lease must block another process");
      assert.deepEqual(await readClaim(), abandonedRows,
        "a blocked process must not release, renew, or mark the claim sent");

      // Advance only this fixture's lease, using database time instead of a
      // ten-minute sleep or a mock of the production claim implementation.
      await db.update(analyticsCoverageAlertsTable)
        .set({ claimedAt: sql`CURRENT_TIMESTAMP - interval '11 minutes'` })
        .where(eq(analyticsCoverageAlertsTable.id, abandoned.id));
      const [expired] = await readClaim();

      const firstReadyFile = path.join(temporaryDirectory, "first-ready");
      const secondReadyFile = path.join(temporaryDirectory, "second-ready");
      // Wait for both exits even on failure, so cleanup cannot race a worker
      // that is still accessing the fixture.
      const settledResults = await Promise.allSettled([
        startCoverageAlertWorker("race", cohort, {
          readyFile: firstReadyFile,
          peerReadyFile: secondReadyFile,
        }),
        startCoverageAlertWorker("race", cohort, {
          readyFile: secondReadyFile,
          peerReadyFile: firstReadyFile,
        }),
      ]);
      const concurrentResults = settledResults.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      assert.deepEqual(
        concurrentResults.map(({ delivered }) => delivered).sort(),
        [false, true],
        "exactly one recovery process must win the expired claim",
      );
      assert.equal(
        concurrentResults.reduce((total, result) => total + result.sends, 0),
        1,
        "concurrent recovery must contact the provider exactly once",
      );
      const recoveredRows = await readClaim();
      assert.equal(recoveredRows.length, 1);
      const recovered = recoveredRows[0]!;
      assert.equal(recovered.id, abandoned.id, "reclaim the original row");
      assert.equal(recovered.createdAt.getTime(), abandoned.createdAt.getTime());
      assert.ok(recovered.claimedAt > expired!.claimedAt, "renew the lease");
      assert.ok(recovered.deliveryStartedAt, "persist the delivery boundary");
      assert.ok(recovered.sentAt, "persist successful delivery");

      assert.deepEqual(await startCoverageAlertWorker("restart", cohort), {
        delivered: false,
        sends: 0,
      }, "another restart must not redeliver the recovered alert");
      assert.deepEqual(await readClaim(), recoveredRows);
    } finally {
      try {
        await db.delete(analyticsCoverageAlertsTable)
          .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  });

  test("unrelated coverage alerts deliver concurrently and persist separate sent rows", async () => {
    const cohorts = [
      `independent-alert-${randomUUID()}`,
      `independent-alert-${randomUUID()}`,
    ];
    const alertKeys = cohorts.map((cohort) => getCoverageRegressionAlertKey({
      cohorts: [{ cohort, requests: 0 }],
    }));
    assert.notEqual(alertKeys[0], alertKeys[1]);
    const fixtureFilter = inArray(analyticsCoverageAlertsTable.alertKey, alertKeys);
    const readFixtures = () => db.select().from(analyticsCoverageAlertsTable)
      .where(fixtureFilter);
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "coverage-alert-independent-"),
    );
    let deletedKeys: string[] = [];

    try {
      const readyFiles = cohorts.map((_, index) =>
        path.join(temporaryDirectory, `worker-${index}-ready`));
      // Settle both children before cleanup, including on barrier failure.
      const results = await Promise.allSettled(cohorts.map((cohort, index) =>
        startCoverageAlertWorker("independent", cohort, {
          readyFile: readyFiles[index]!,
          peerReadyFile: readyFiles[1 - index]!,
        })));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        assert.deepEqual(result.value, { delivered: true, sends: 1, fallbackSends: 0 },
          "each unrelated alert must contact the provider exactly once");
      }

      const sentRows = await readFixtures();
      assert.equal(sentRows.length, 2);
      assert.notEqual(sentRows[0]!.id, sentRows[1]!.id);
      for (const [index, alertKey] of alertKeys.entries()) {
        const row = sentRows.find((candidate) => candidate.alertKey === alertKey);
        assert.ok(row, "each cohort must persist its own alert row");
        assert.deepEqual(row.cohortDates, [cohorts[index]]);
        assert.ok(row.deliveryStartedAt, "persist each delivery boundary");
        assert.ok(row.sentAt, "persist each successful send");
      }
    } finally {
      try {
        const deleted = await db.delete(analyticsCoverageAlertsTable)
          .where(fixtureFilter)
          .returning({ alertKey: analyticsCoverageAlertsTable.alertKey });
        deletedKeys = deleted.map(({ alertKey }) => alertKey);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
    assert.deepEqual(deletedKeys.sort(), [...alertKeys].sort(),
      "cleanup must delete only the two UUID-scoped fixture rows");
    assert.deepEqual(await readFixtures(), [], "no fixture rows may remain");
  });

  test("independent API processes share coverage alert claims across a restart", async () => {
    const cohort = new Date(
      Date.UTC(2000, 0, 1) + Math.floor(Math.random() * 365_000) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const alertKey = getCoverageRegressionAlertKey({
      cohorts: [{ cohort, requests: 0 }],
    });
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "coverage-alert-processes-"),
    );

    try {
      const firstReadyFile = path.join(temporaryDirectory, "first-ready");
      const secondReadyFile = path.join(temporaryDirectory, "second-ready");
      const concurrentResults = await Promise.all([
        startCoverageAlertWorker("race", cohort, {
          readyFile: firstReadyFile,
          peerReadyFile: secondReadyFile,
        }),
        startCoverageAlertWorker("race", cohort, {
          readyFile: secondReadyFile,
          peerReadyFile: firstReadyFile,
        }),
      ]);

      assert.deepEqual(
        concurrentResults.map(({ delivered }) => delivered).sort(),
        [false, true],
      );
      assert.equal(
        concurrentResults.reduce((total, result) => total + result.sends, 0),
        1,
        "only one API process should deliver a matching alert",
      );

      const [sentAlert] = await db
        .select({ sentAt: analyticsCoverageAlertsTable.sentAt })
        .from(analyticsCoverageAlertsTable)
        .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
      assert.ok(sentAlert?.sentAt, "the delivered alert should be persisted as sent");

      assert.deepEqual(await startCoverageAlertWorker("restart", cohort), {
        delivered: false,
        sends: 0,
      });
    } finally {
      await db
        .delete(analyticsCoverageAlertsTable)
        .where(eq(analyticsCoverageAlertsTable.alertKey, alertKey));
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
}
