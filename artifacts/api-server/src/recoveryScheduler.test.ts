import assert from "node:assert/strict";
import test from "node:test";

import {
  createApiRecoveryScheduler,
  createRecoveryScheduler,
  MAX_RECOVERY_SHUTDOWN_GRACE_MS,
  MIN_RECOVERY_SHUTDOWN_GRACE_MS,
  parseRecoveryShutdownGraceMs,
  RECOVERY_SHUTDOWN_GRACE_ENV,
  RECOVERY_SHUTDOWN_GRACE_MS,
  ANALYTICS_COVERAGE_NOTIFICATION_INTERVAL_MS,
  SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS,
  WELCOME_EMAIL_RECOVERY_INTERVAL_MS,
  type RecoveryClearInterval,
  type RecoverySetInterval,
} from "./recoveryScheduler";

test("recovery shutdown grace configuration uses the safe default when unset", () => {
  assert.equal(
    parseRecoveryShutdownGraceMs(undefined),
    RECOVERY_SHUTDOWN_GRACE_MS,
  );
});

test("recovery shutdown grace configuration accepts bounded whole milliseconds", () => {
  assert.equal(
    parseRecoveryShutdownGraceMs(` ${MIN_RECOVERY_SHUTDOWN_GRACE_MS} `),
    MIN_RECOVERY_SHUTDOWN_GRACE_MS,
  );
  assert.equal(
    parseRecoveryShutdownGraceMs(String(MAX_RECOVERY_SHUTDOWN_GRACE_MS)),
    MAX_RECOVERY_SHUTDOWN_GRACE_MS,
  );
});

test("recovery shutdown grace configuration rejects unsafe values", () => {
  for (const rawValue of [
    "",
    "0",
    String(MIN_RECOVERY_SHUTDOWN_GRACE_MS - 1),
    "100.5",
    String(MAX_RECOVERY_SHUTDOWN_GRACE_MS + 1),
    "not-a-number",
  ]) {
    assert.throws(
      () => parseRecoveryShutdownGraceMs(rawValue),
      new RegExp(`${RECOVERY_SHUTDOWN_GRACE_ENV}.*${rawValue || '""'}`),
    );
  }
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("API startup runs each recovery once and keeps their errors associated", async () => {
  const spotlightFailure = deferred();
  const welcomeFailure = deferred();
  const errors: Array<{ message: string; error: unknown }> = [];
  const scheduled: Array<() => void> = [];
  let spotlightRuns = 0;
  let welcomeRuns = 0;

  const scheduler = createApiRecoveryScheduler({
    recoverSpotlightNotifications: async () => {
      spotlightRuns += 1;
      throw new Error("spotlight startup failure");
    },
    recoverWelcomeEmails: async () => {
      welcomeRuns += 1;
      throw new Error("welcome startup failure");
    },
    getNewsletterFunnelReport: async () => {
      return {} as Awaited<
        ReturnType<
          typeof import("./lib/newsletterFunnelAnalytics").getNewsletterFunnelReport
        >
      >;
    },
    notifyNewsletterCoverageRegressions: async () => false,
    getPublicBaseUrl: (host) => {
      assert.equal(host, undefined);
      return "https://top-dog-tricks.example";
    },
    logger: {
      error: (details, message) => {
        errors.push({ message, error: (details as { err?: unknown }).err });
        if (message.includes("spotlight")) spotlightFailure.resolve();
        if (message.includes("welcome")) welcomeFailure.resolve();
      },
      info: () => {},
    },
    setInterval: (callback, delayMs) => {
      assert.equal(
        delayMs,
        scheduled.length < 2
          ? 60 * 1_000
          : ANALYTICS_COVERAGE_NOTIFICATION_INTERVAL_MS,
      );
      scheduled.push(callback);
      return {} as ReturnType<typeof globalThis.setInterval>;
    },
  });

  scheduler.start();
  await Promise.all([spotlightFailure.promise, welcomeFailure.promise]);

  assert.equal(spotlightRuns, 1);
  assert.equal(welcomeRuns, 1);
  assert.equal(scheduled.length, 3);
  assert.deepEqual(
    errors
      .map(({ message, error }) => [message, (error as Error).message])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      [
        "Scheduled spotlight notification recovery failed",
        "spotlight startup failure",
      ],
      ["Scheduled welcome email recovery failed", "welcome startup failure"],
    ],
  );
});

test("welcome recovery is not blocked by a slow spotlight recovery", async () => {
  const spotlightStarted = deferred();
  const releaseSpotlight = deferred();
  const welcomeFirstRunFinished = deferred();
  const welcomeSecondRunStarted = deferred();
  const releaseWelcomeSecondRun = deferred();
  const welcomeFailureRecorded = deferred();
  const spotlightFailureRecorded = deferred();
  const scheduled: Array<() => void> = [];
  const failures: Array<{ job: "spotlight" | "welcome"; error: unknown }> = [];
  let spotlightRuns = 0;
  let welcomeRuns = 0;

  const setInterval: RecoverySetInterval = (callback, delayMs) => {
    assert.equal(delayMs, 60 * 1_000);
    scheduled.push(callback);
    return {} as ReturnType<typeof globalThis.setInterval>;
  };

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      spotlightRuns += 1;
      spotlightStarted.resolve();
      await releaseSpotlight.promise;
      throw new Error("spotlight recovery failed");
    },
    runWelcomeRecovery: async () => {
      welcomeRuns += 1;
      if (welcomeRuns === 1) {
        welcomeFirstRunFinished.resolve();
        return;
      }
      welcomeSecondRunStarted.resolve();
      await releaseWelcomeSecondRun.promise;
      throw new Error("welcome recovery failed");
    },
    onSpotlightError: (error) => {
      failures.push({ job: "spotlight", error });
      spotlightFailureRecorded.resolve();
    },
    onWelcomeError: (error) => {
      failures.push({ job: "welcome", error });
      welcomeFailureRecorded.resolve();
    },
    setInterval,
  });

  scheduler.start();
  await Promise.all([
    spotlightStarted.promise,
    welcomeFirstRunFinished.promise,
  ]);

  scheduled[0]?.();
  scheduled[1]?.();
  await welcomeSecondRunStarted.promise;
  scheduled[1]?.();

  assert.equal(spotlightRuns, 1, "overlapping spotlight recovery is skipped");
  assert.equal(welcomeRuns, 2, "overlapping welcome recovery is skipped");

  releaseWelcomeSecondRun.resolve();
  await welcomeFailureRecorded.promise;
  assert.deepEqual(
    failures.map(({ job, error }) => [job, (error as Error).message]),
    [["welcome", "welcome recovery failed"]],
  );

  releaseSpotlight.resolve();
  await spotlightFailureRecorded.promise;

  assert.deepEqual(
    failures.map(({ job, error }) => [job, (error as Error).message]),
    [
      ["welcome", "welcome recovery failed"],
      ["spotlight", "spotlight recovery failed"],
    ],
  );
});

test("a transient recovery failure can retry without blocking the other job", async () => {
  const spotlightStarted = deferred();
  const releaseSpotlight = deferred();
  const spotlightFailureRecorded = deferred();
  const spotlightRetryCompleted = deferred();
  const welcomeRunsCompleted = deferred();
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
  }> = [];
  const failures: unknown[] = [];
  let spotlightRuns = 0;
  let welcomeRuns = 0;

  const setInterval: RecoverySetInterval = (callback, delayMs) => {
    const expectedDelay =
      scheduled.length === 0
        ? SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS
        : WELCOME_EMAIL_RECOVERY_INTERVAL_MS;
    assert.equal(delayMs, expectedDelay);
    scheduled.push({ callback, delayMs });
    return {} as ReturnType<typeof globalThis.setInterval>;
  };

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      spotlightRuns += 1;
      if (spotlightRuns === 1) {
        spotlightStarted.resolve();
        await releaseSpotlight.promise;
        throw new Error("transient spotlight recovery failure");
      }
      spotlightRetryCompleted.resolve();
    },
    runWelcomeRecovery: async () => {
      welcomeRuns += 1;
      if (welcomeRuns === 2) {
        welcomeRunsCompleted.resolve();
      }
    },
    onSpotlightError: (error) => {
      failures.push(error);
      spotlightFailureRecorded.resolve();
    },
    onWelcomeError: () => {
      assert.fail("welcome recovery should remain runnable and succeed");
    },
    setInterval,
  });

  scheduler.start();
  await spotlightStarted.promise;

  const welcomeTimer = scheduled[1];
  assert.ok(welcomeTimer);
  welcomeTimer.callback();
  await welcomeRunsCompleted.promise;

  assert.equal(spotlightRuns, 1);
  assert.equal(
    welcomeRuns,
    2,
    "welcome recovery remains independently runnable",
  );

  releaseSpotlight.resolve();
  await spotlightFailureRecorded.promise;
  assert.equal(failures.length, 1);

  const spotlightTimer = scheduled[0];
  assert.ok(spotlightTimer);
  spotlightTimer.callback();
  await spotlightRetryCompleted.promise;

  assert.equal(
    spotlightRuns,
    2,
    "spotlight recovery retries after the failure",
  );
  assert.equal(failures.length, 1, "the transient failure is recorded once");
});

test("a reporting failure does not block a later recovery retry", async () => {
  const reportingFailureObserved = deferred();
  const retryCompleted = deferred();
  const scheduled: Array<() => void> = [];
  const recoveryFailure = new Error("spotlight recovery failed");
  const reportingFailure = new Error("error reporting failed");
  const failures: unknown[] = [];
  const loggedErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  let spotlightRuns = 0;

  console.error = (...args) => {
    loggedErrors.push(args);
    reportingFailureObserved.resolve();
  };

  try {
    const scheduler = createRecoveryScheduler({
      runSpotlightRecovery: async () => {
        spotlightRuns += 1;
        if (spotlightRuns === 1) {
          throw recoveryFailure;
        }
        retryCompleted.resolve();
      },
      runWelcomeRecovery: async () => {},
      onSpotlightError: (error) => {
        failures.push(error);
        throw reportingFailure;
      },
      onWelcomeError: () => assert.fail("welcome recovery should not fail"),
      setInterval: (callback, delayMs) => {
        assert.equal(delayMs, SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS);
        scheduled.push(callback);
        return {} as ReturnType<typeof globalThis.setInterval>;
      },
    });

    scheduler.start();
    await reportingFailureObserved.promise;
    await Promise.resolve();

    assert.deepEqual(failures, [recoveryFailure]);
    assert.equal(loggedErrors.length, 1);
    assert.equal(
      loggedErrors[0]?.[0],
      "Scheduled spotlight recovery error reporting failed",
    );
    assert.deepEqual(loggedErrors[0]?.[1], {
      recoveryError: recoveryFailure,
      reportingError: reportingFailure,
    });

    scheduled[0]?.();
    await retryCompleted.promise;
    assert.equal(spotlightRuns, 2);

    scheduler.stop();
  } finally {
    console.error = originalConsoleError;
  }
});

test("a throwing final logging fallback does not reject a scheduled recovery", async () => {
  const recoveryFailure = new Error("spotlight recovery failed");
  const reportingFailure = new Error("error reporting failed");
  const fallbackFailure = new Error("console logging failed");
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
  }> = [];
  const fallbackCalls: unknown[][] = [];
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  const originalConsoleError = console.error;
  let spotlightRuns = 0;
  process.on("unhandledRejection", onUnhandledRejection);
  console.error = (...args) => {
    fallbackCalls.push(args);
    throw fallbackFailure;
  };

  try {
    const scheduler = createRecoveryScheduler({
      runSpotlightRecovery: async () => {
        spotlightRuns += 1;
        if (spotlightRuns === 2) throw recoveryFailure;
      },
      runWelcomeRecovery: async () => {},
      onSpotlightError: () => {
        throw reportingFailure;
      },
      onWelcomeError: () => assert.fail("welcome recovery should not fail"),
      setInterval: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return {} as ReturnType<typeof globalThis.setInterval>;
      },
      clearInterval: () => {},
    });

    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const spotlightTimer = scheduled.find(
      ({ delayMs }) => delayMs === SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS,
    );
    assert.ok(spotlightTimer);
    spotlightTimer.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(fallbackCalls, [
      [
        "Scheduled spotlight recovery error reporting failed",
        {
          recoveryError: recoveryFailure,
          reportingError: reportingFailure,
        },
      ],
    ]);
    assert.deepEqual(unhandledRejections, []);

    scheduler.stop();
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    console.error = originalConsoleError;
  }
});

test("a welcome reporting failure does not block a later recovery retry", async () => {
  const retryCompleted = deferred();
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
  }> = [];
  const recoveryFailure = new Error("welcome recovery failed");
  const reportingFailure = new Error("welcome error reporting failed");
  const failures: unknown[] = [];
  const loggedErrors: unknown[][] = [];
  const unhandledRejections: unknown[] = [];
  const originalConsoleError = console.error;
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  let welcomeRuns = 0;

  console.error = (...args) => {
    loggedErrors.push(args);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const scheduler = createRecoveryScheduler({
      runSpotlightRecovery: async () => {},
      runWelcomeRecovery: async () => {
        welcomeRuns += 1;
        if (welcomeRuns === 1) {
          throw recoveryFailure;
        }
        retryCompleted.resolve();
      },
      onSpotlightError: () => assert.fail("spotlight recovery should not fail"),
      onWelcomeError: (error) => {
        failures.push(error);
        throw reportingFailure;
      },
      setInterval: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return {} as ReturnType<typeof globalThis.setInterval>;
      },
    });

    scheduler.start();
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(failures, [recoveryFailure]);
    assert.equal(loggedErrors.length, 1);
    assert.equal(
      loggedErrors[0]?.[0],
      "Scheduled welcome recovery error reporting failed",
    );
    assert.deepEqual(loggedErrors[0]?.[1], {
      recoveryError: recoveryFailure,
      reportingError: reportingFailure,
    });

    const welcomeTimer = scheduled[1];
    assert.ok(welcomeTimer);
    assert.equal(welcomeTimer.delayMs, WELCOME_EMAIL_RECOVERY_INTERVAL_MS);
    welcomeTimer.callback();
    await retryCompleted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(welcomeRuns, 2);
    assert.deepEqual(unhandledRejections, []);

    scheduler.stop();
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    console.error = originalConsoleError;
  }
});

test("an analytics reporting failure does not block a later recovery retry", async () => {
  const reportingFailureObserved = deferred();
  const retryCompleted = deferred();
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
  }> = [];
  const recoveryFailure = new Error("analytics coverage recovery failed");
  const reportingFailure = new Error("analytics error reporting failed");
  const failures: unknown[] = [];
  const loggedErrors: unknown[][] = [];
  const unhandledRejections: unknown[] = [];
  const originalConsoleError = console.error;
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  let analyticsRuns = 0;

  console.error = (...args) => {
    loggedErrors.push(args);
    reportingFailureObserved.resolve();
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const scheduler = createRecoveryScheduler({
      runSpotlightRecovery: async () => {},
      runWelcomeRecovery: async () => {},
      runAnalyticsCoverageNotification: async () => {
        analyticsRuns += 1;
        if (analyticsRuns === 1) {
          throw recoveryFailure;
        }
        retryCompleted.resolve();
      },
      onSpotlightError: () => assert.fail("spotlight recovery should not fail"),
      onWelcomeError: () => assert.fail("welcome recovery should not fail"),
      onAnalyticsCoverageError: (error) => {
        failures.push(error);
        throw reportingFailure;
      },
      setInterval: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return {} as ReturnType<typeof globalThis.setInterval>;
      },
      clearInterval: () => {},
    });

    scheduler.start();
    await reportingFailureObserved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(failures, [recoveryFailure]);
    assert.equal(loggedErrors.length, 1);
    assert.equal(
      loggedErrors[0]?.[0],
      "Scheduled analytics coverage notification recovery error reporting failed",
    );
    assert.deepEqual(loggedErrors[0]?.[1], {
      recoveryError: recoveryFailure,
      reportingError: reportingFailure,
    });

    const analyticsTimer = scheduled.find(
      ({ delayMs }) => delayMs === ANALYTICS_COVERAGE_NOTIFICATION_INTERVAL_MS,
    );
    assert.ok(analyticsTimer, "analytics coverage timer is registered");
    analyticsTimer.callback();
    await retryCompleted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(analyticsRuns, 2);
    assert.deepEqual(unhandledRejections, []);

    scheduler.stop();
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    console.error = originalConsoleError;
  }
});

test("API reports secondary recovery failures through structured logging", async () => {
  const secondaryFailureObserved = deferred();
  const recoveryFailure = new Error("spotlight recovery failed");
  const reportingFailure = new Error("structured reporting failed");
  const unhandledRejections: unknown[] = [];
  const alerts: Array<{
    details: unknown;
    message: string;
  }> = [];
  let loggerErrorCalls = 0;
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const scheduler = createApiRecoveryScheduler({
      recoverSpotlightNotifications: async () => {
        throw recoveryFailure;
      },
      recoverWelcomeEmails: async () => {},
      getPublicBaseUrl: () => "https://top-dog-tricks.example",
      logger: {
        error: (details, message) => {
          loggerErrorCalls += 1;
          if (loggerErrorCalls === 1) {
            throw reportingFailure;
          }
          alerts.push({ details, message });
          secondaryFailureObserved.resolve();
        },
        info: () => {},
      },
      setInterval: () => {
        return {} as ReturnType<typeof globalThis.setInterval>;
      },
    });

    scheduler.start();
    await secondaryFailureObserved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(loggerErrorCalls, 2);
    assert.deepEqual(alerts, [
      {
        details: {
          recoveryError: recoveryFailure,
          reportingError: reportingFailure,
        },
        message: "Scheduled spotlight recovery error reporting failed",
      },
    ]);
    assert.deepEqual(unhandledRejections, []);

    scheduler.stop();
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

for (const scenario of ["fallback succeeds", "fallback fails", "logger throws"] as const) {
  test(`scheduled API coverage provider errors remain visible when ${scenario}`, async () => {
    const { notifyNewsletterCoverageRegressions } = await import("./lib/newsletterFunnelNotifications");
    const slackError = new Error("Slack provider unavailable");
    const resendError = new Error("Resend provider unavailable");
    const loggerCalls: Array<{ details: unknown; message: string }> = [];
    const events: string[] = [];
    const results: boolean[] = [];
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const originalClickhouseUrl = process.env["CLICKHOUSE_URL"];
    let reportCalls = 0;
    const report: import("./lib/newsletterFunnelAnalytics").NewsletterFunnelReport = {
      reportAsOf: "October 10, 2026 (UTC)",
      coverage: {
        startDate: "2026-06-29",
        status: "recorded",
        auditTrail: [],
        cohorts: [{ cohort: "2026-08-03", coverageStatus: "zero_requests", requests: 0 }],
        alerts: [{ kind: "coverage_regression", cohorts: ["2026-08-03"] }],
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
    const scheduler = createApiRecoveryScheduler({
      recoverSpotlightNotifications: async () => {},
      recoverWelcomeEmails: async () => {},
      getNewsletterFunnelReport: async () => {
        reportCalls += 1;
        // Keep startup quiet so the regression is exercised by the timer.
        return reportCalls === 1
          ? { ...report, coverage: { ...report.coverage, alerts: [] } }
          : report;
      },
      notifyNewsletterCoverageRegressions: async (scheduledReport, dependencies) => {
        const result = await notifyNewsletterCoverageRegressions(scheduledReport, {
          ...dependencies,
          claimAlert: async () => 42,
          startAlertDelivery: async () => true,
          sendAlert: async () => {
            events.push("Slack");
            throw slackError;
          },
          sendFallbackAlert: async () => {
            events.push("Resend");
            if (scenario === "fallback fails") throw resendError;
          },
          markAlertSent: async (id) => {
            assert.equal(id, 42);
            events.push("sent");
          },
          releaseAlert: async (id) => {
            assert.equal(id, 42);
            events.push("released");
          },
        });
        results.push(result);
        return result;
      },
      getPublicBaseUrl: () => "https://top-dog-tricks.example",
      logger: {
        error: (details, message) => {
          loggerCalls.push({ details, message });
          events.push("logged");
          if (scenario === "logger throws") throw new Error("operator logger unavailable");
        },
        info: () => {},
      },
      setInterval: (callback, delay) => {
        scheduled.push({ callback, delay });
        return {} as ReturnType<typeof globalThis.setInterval>;
      },
      clearInterval: () => {},
    });

    process.env["CLICKHOUSE_URL"] = "configured-for-test";
    try {
      scheduler.start();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(results, [false]);
      assert.equal(loggerCalls.length, 0);
      const timer = scheduled.find(({ delay }) => delay === ANALYTICS_COVERAGE_NOTIFICATION_INTERVAL_MS);
      assert.ok(timer, "coverage notification timer is registered");
      timer.callback();
      assert.equal(await scheduler.stopAndDrain(1_000), "drained");

      const expectedErrors = scenario === "fallback fails"
        ? [{ channel: "Slack", err: slackError }, { channel: "Resend", err: resendError }]
        : [{ channel: "Slack", err: slackError }];
      assert.deepEqual(loggerCalls, expectedErrors.map((details) => ({
        details,
        message: "Scheduled newsletter funnel coverage provider failed",
      })));
      for (const [index, expected] of expectedErrors.entries()) {
        assert.equal(
          (loggerCalls[index]!.details as { err: unknown }).err,
          expected.err,
          "the original provider error is retained, not replaced or stringified",
        );
      }
      assert.equal(reportCalls, 2);
      assert.deepEqual(results, [false, scenario !== "fallback fails"]);
      assert.deepEqual(events, scenario === "fallback fails"
        ? ["Slack", "logged", "Resend", "logged", "released"]
        : ["Slack", "logged", "Resend", "sent"]);
    } finally {
      await scheduler.stopAndDrain(1_000);
      if (originalClickhouseUrl === undefined) delete process.env["CLICKHOUSE_URL"];
      else process.env["CLICKHOUSE_URL"] = originalClickhouseUrl;
    }
  });
}

test("API keeps analytics coverage failures visible when error reporting throws", async () => {
  const secondaryFailureObserved = deferred();
  const recoveryFailure = new Error("analytics coverage report failed");
  const reportingFailure = new Error("analytics failure reporting failed");
  const loggerCalls: Array<{ details: unknown; message: string }> = [];
  const unhandledRejections: unknown[] = [];
  const originalClickhouseUrl = process.env["CLICKHOUSE_URL"];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  let reportCalls = 0;
  let notificationCalls = 0;

  process.env["CLICKHOUSE_URL"] = "configured-for-test";
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const scheduler = createApiRecoveryScheduler({
      recoverSpotlightNotifications: async () => {},
      recoverWelcomeEmails: async () => {},
      getNewsletterFunnelReport: async () => {
        reportCalls += 1;
        throw recoveryFailure;
      },
      notifyNewsletterCoverageRegressions: async () => {
        notificationCalls += 1;
        return false;
      },
      getPublicBaseUrl: () => "https://top-dog-tricks.example",
      logger: {
        error: (details, message) => {
          loggerCalls.push({ details, message });
          if (loggerCalls.length === 1) {
            throw reportingFailure;
          }
          secondaryFailureObserved.resolve();
        },
        info: () => {},
      },
      setInterval: () =>
        ({} as ReturnType<typeof globalThis.setInterval>),
    });

    scheduler.start();
    await secondaryFailureObserved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(reportCalls, 1, "the failed report is not generated again");
    assert.equal(
      notificationCalls,
      0,
      "notification handling is not reached after report generation fails",
    );
    assert.deepEqual(loggerCalls, [
      {
        details: { err: recoveryFailure },
        message: "Scheduled analytics coverage notification failed",
      },
      {
        details: {
          recoveryError: recoveryFailure,
          reportingError: reportingFailure,
        },
        message:
          "Scheduled analytics coverage notification recovery error reporting failed",
      },
    ]);
    assert.deepEqual(unhandledRejections, []);

    scheduler.stop();
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    if (originalClickhouseUrl === undefined) {
      delete process.env["CLICKHOUSE_URL"];
    } else {
      process.env["CLICKHOUSE_URL"] = originalClickhouseUrl;
    }
  }
});

test("a failed structured logger falls back without retrying the error callback", async () => {
  const fallbackObserved = deferred();
  const recoveryFailure = new Error("spotlight recovery failed");
  const reportingFailure = new Error("error callback logging failed");
  const loggerFailure = new Error("structured logger unavailable");
  const fallbackLogs: unknown[][] = [];
  const unhandledRejections: unknown[] = [];
  const originalConsoleError = console.error;
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  let errorCallbackCalls = 0;
  let loggerErrorCalls = 0;

  console.error = (...args) => {
    fallbackLogs.push(args);
    fallbackObserved.resolve();
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const scheduler = createRecoveryScheduler({
      runSpotlightRecovery: async () => {
        throw recoveryFailure;
      },
      runWelcomeRecovery: async () => {},
      onSpotlightError: () => {
        errorCallbackCalls += 1;
        throw reportingFailure;
      },
      onWelcomeError: () => assert.fail("welcome recovery should not fail"),
      logger: {
        error: () => {
          loggerErrorCalls += 1;
          throw loggerFailure;
        },
        info: () => {},
      },
      setInterval: () =>
        ({} as ReturnType<typeof globalThis.setInterval>),
    });

    scheduler.start();
    await fallbackObserved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(errorCallbackCalls, 1);
    assert.equal(loggerErrorCalls, 1);
    assert.deepEqual(fallbackLogs, [
      [
        "Scheduled spotlight recovery error reporting failed; structured logging failed",
        {
          recoveryError: recoveryFailure,
          reportingError: reportingFailure,
          loggerError: loggerFailure,
        },
      ],
    ]);
    assert.deepEqual(unhandledRejections, []);

    scheduler.stop();
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    console.error = originalConsoleError;
  }
});
test("repeated startup does not duplicate timers and stop clears both", () => {
  const scheduled: Array<ReturnType<typeof globalThis.setInterval>> = [];
  const cleared: Array<ReturnType<typeof globalThis.setInterval>> = [];
  let spotlightRuns = 0;
  let welcomeRuns = 0;

  const setInterval: RecoverySetInterval = (callback) => {
    void callback;
    const handle = {} as ReturnType<typeof globalThis.setInterval>;
    scheduled.push(handle);
    return handle;
  };
  const clearInterval: RecoveryClearInterval = (handle) => {
    cleared.push(handle);
  };

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      spotlightRuns += 1;
    },
    runWelcomeRecovery: async () => {
      welcomeRuns += 1;
    },
    onSpotlightError: () => {},
    onWelcomeError: () => {},
    setInterval,
    clearInterval,
  });

  scheduler.start();
  scheduler.start();
  scheduler.stop();
  scheduler.stop();

  assert.equal(spotlightRuns, 1);
  assert.equal(welcomeRuns, 1);
  assert.equal(scheduled.length, 2);
  assert.deepEqual(cleared, scheduled);
});

test("a timer registration failure cleans up partial startup and allows retry", () => {
  const scheduled: Array<ReturnType<typeof globalThis.setInterval>> = [];
  const cleared: Array<ReturnType<typeof globalThis.setInterval>> = [];
  let setIntervalCalls = 0;

  const setInterval: RecoverySetInterval = () => {
    setIntervalCalls += 1;
    if (setIntervalCalls === 2) {
      throw new Error("transient timer registration failure");
    }
    const handle = {} as ReturnType<typeof globalThis.setInterval>;
    scheduled.push(handle);
    return handle;
  };
  const clearInterval: RecoveryClearInterval = (handle) => {
    cleared.push(handle);
  };

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {},
    runWelcomeRecovery: async () => {},
    onSpotlightError: () => {},
    onWelcomeError: () => {},
    setInterval,
    clearInterval,
  });

  assert.throws(
    () => scheduler.start(),
    new Error("transient timer registration failure"),
  );
  assert.deepEqual(cleared, [scheduled[0]]);

  scheduler.start();
  scheduler.stop();

  assert.equal(setIntervalCalls, 4);
  assert.equal(scheduled.length, 3);
  assert.deepEqual(cleared, [scheduled[0], scheduled[1], scheduled[2]]);
});

test("startup rollback clears every timer and preserves cleanup failures", () => {
  const scheduled: Array<ReturnType<typeof globalThis.setInterval>> = [];
  const scheduledCallbacks: Array<() => void> = [];
  const clearAttempts: Array<ReturnType<typeof globalThis.setInterval>> = [];
  const registrationFailure = new Error("timer registration failed");
  const cleanupFailure = new Error("timer cancellation failed");
  let registrationCalls = 0;
  let failRegistration = true;
  let failCleanup = true;
  let spotlightRuns = 0;

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      spotlightRuns += 1;
    },
    runWelcomeRecovery: async () => {},
    runAnalyticsCoverageNotification: async () => {},
    onSpotlightError: () => {},
    onWelcomeError: () => {},
    setInterval: (callback) => {
      registrationCalls += 1;
      if (registrationCalls === 3 && failRegistration) {
        failRegistration = false;
        throw registrationFailure;
      }
      const handle = {
        id: registrationCalls,
      } as unknown as ReturnType<typeof globalThis.setInterval>;
      scheduled.push(handle);
      scheduledCallbacks.push(callback);
      return handle;
    },
    clearInterval: (handle) => {
      clearAttempts.push(handle);
      if (failCleanup && handle === scheduled[0]) {
        failCleanup = false;
        throw cleanupFailure;
      }
    },
  });

  assert.throws(
    () => scheduler.start(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Recovery scheduler startup failed and timer cleanup was incomplete",
      );
      assert.deepEqual(error.errors, [registrationFailure, cleanupFailure]);
      assert.equal(error.cause, registrationFailure);
      return true;
    },
  );
  assert.deepEqual(clearAttempts, scheduled);

  scheduler.start();
  assert.equal(spotlightRuns, 1);
  scheduledCallbacks[0]?.();
  assert.equal(
    spotlightRuns,
    1,
    "a timer left by failed rollback cannot run after restart",
  );
  scheduler.stop();
  assert.equal(registrationCalls, 6);
  assert.equal(scheduled.length, 5);
  assert.deepEqual(clearAttempts, scheduled);
});

test("shutdown reports cancellation failures, clears all timers, and can restart", async () => {
  const scheduled: Array<ReturnType<typeof globalThis.setInterval>> = [];
  const scheduledCallbacks: Array<() => void> = [];
  const clearAttempts: Array<ReturnType<typeof globalThis.setInterval>> = [];
  const cleanupFailure = new Error("welcome timer cancellation failed");
  const reported: Array<{ error: unknown; message: string }> = [];
  let failCleanup = true;
  let spotlightRuns = 0;

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      spotlightRuns += 1;
    },
    runWelcomeRecovery: async () => {},
    runAnalyticsCoverageNotification: async () => {},
    onSpotlightError: () => {},
    onWelcomeError: () => {},
    logger: {
      error: (details, message) => {
        reported.push({
          error: (details as { err?: unknown }).err,
          message,
        });
      },
      info: () => {},
    },
    setInterval: (callback) => {
      const handle = {
        id: scheduled.length,
      } as unknown as ReturnType<typeof globalThis.setInterval>;
      scheduled.push(handle);
      scheduledCallbacks.push(callback);
      return handle;
    },
    clearInterval: (handle) => {
      clearAttempts.push(handle);
      if (failCleanup && handle === scheduled[1]) {
        failCleanup = false;
        throw cleanupFailure;
      }
    },
  });

  scheduler.start();
  assert.equal(await scheduler.stopAndDrain(1_000), "drained");
  assert.equal(spotlightRuns, 1);
  assert.deepEqual(clearAttempts, scheduled);
  assert.equal(reported.length, 1);
  assert.equal(
    reported[0]?.message,
    "Recovery scheduler interval cleanup failed",
  );
  assert.ok(reported[0]?.error instanceof AggregateError);
  assert.deepEqual(
    (reported[0]?.error as AggregateError).errors,
    [cleanupFailure],
  );

  scheduler.start();
  assert.equal(spotlightRuns, 2);
  scheduledCallbacks[0]?.();
  assert.equal(
    spotlightRuns,
    2,
    "a timer left by failed shutdown cannot run after restart",
  );
  assert.equal(await scheduler.stopAndDrain(1_000), "drained");
  assert.equal(scheduled.length, 6);
  assert.deepEqual(clearAttempts, scheduled);
  assert.equal(reported.length, 1, "successful cleanup is not reported");
});

for (const shutdown of ["stop", "stopAndDrain"] as const) {
  test(`${shutdown} preserves multiple cancellation failures and attempts every timer`, async () => {
    const scheduled: Array<ReturnType<typeof globalThis.setInterval>> = [];
    const clearAttempts: Array<ReturnType<typeof globalThis.setInterval>> = [];
    const cleanupFailures = [
      new Error("spotlight timer cancellation failed"),
      new Error("welcome timer cancellation failed"),
    ];
    const reported: Array<{ error: unknown; message: string }> = [];
    const scheduler = createRecoveryScheduler({
      runSpotlightRecovery: async () => {},
      runWelcomeRecovery: async () => {},
      runAnalyticsCoverageNotification: async () => {},
      onSpotlightError: () => assert.fail("spotlight recovery should not fail"),
      onWelcomeError: () => assert.fail("welcome recovery should not fail"),
      logger: {
        error: (details, message) => {
          reported.push({ error: (details as { err: unknown }).err, message });
        },
        info: () => {},
      },
      setInterval: () => {
        const handle = {
          id: scheduled.length,
        } as unknown as ReturnType<typeof globalThis.setInterval>;
        scheduled.push(handle);
        return handle;
      },
      clearInterval: (handle) => {
        clearAttempts.push(handle);
        const failure = cleanupFailures[scheduled.indexOf(handle)];
        if (failure) throw failure;
      },
    });

    const assertCleanupFailures = (error: unknown): true => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Failed to clear one or more recovery scheduler intervals",
      );
      assert.equal(error.errors.length, cleanupFailures.length);
      cleanupFailures.forEach((failure, index) => {
        assert.equal(error.errors[index], failure, "retain each original failure");
      });
      return true;
    };

    scheduler.start();
    assert.equal(scheduled.length, 3);
    if (shutdown === "stop") {
      assert.throws(() => scheduler.stop(), assertCleanupFailures);
      assert.equal(reported.length, 0);
    } else {
      assert.equal(await scheduler.stopAndDrain(1_000), "drained");
      assert.equal(reported.length, 1);
      assert.equal(reported[0]!.message, "Recovery scheduler interval cleanup failed");
      assertCleanupFailures(reported[0]!.error);
    }
    assert.deepEqual(
      clearAttempts,
      scheduled,
      "attempt every timer, including the healthy timer after both failures",
    );
  });
}

test("stopAndDrain waits for active recovery deliveries", async () => {
  const releaseSpotlight = deferred();
  const scheduled: Array<() => void> = [];
  let spotlightRuns = 0;

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      spotlightRuns += 1;
      await releaseSpotlight.promise;
    },
    runWelcomeRecovery: async () => {},
    onSpotlightError: () => assert.fail("spotlight recovery should not fail"),
    onWelcomeError: () => assert.fail("welcome recovery should not fail"),
    setInterval: (callback) => {
      scheduled.push(callback);
      return {} as ReturnType<typeof globalThis.setInterval>;
    },
  });

  scheduler.start();
  const drain = scheduler.stopAndDrain(1_000);
  scheduled[0]?.();

  assert.equal(
    await Promise.race([drain, Promise.resolve("still draining")]),
    "still draining",
  );
  releaseSpotlight.resolve();
  assert.equal(await drain, "drained");
  assert.equal(spotlightRuns, 1);
});

test("a later scheduled recovery runs after a failed recovery settles", async () => {
  const firstFailureReported = deferred();
  const scheduled: Array<() => void> = [];
  const recoveryFailure = new Error("spotlight recovery failed");
  const errors: unknown[] = [];
  let spotlightRuns = 0;

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      spotlightRuns += 1;
      if (spotlightRuns === 1) throw recoveryFailure;
    },
    runWelcomeRecovery: async () => {},
    onSpotlightError: (error) => {
      errors.push(error);
      firstFailureReported.resolve();
    },
    onWelcomeError: () => assert.fail("welcome recovery should not fail"),
    setInterval: (callback) => {
      scheduled.push(callback);
      return {} as ReturnType<typeof globalThis.setInterval>;
    },
    clearInterval: () => {},
  });

  scheduler.start();
  await firstFailureReported.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));

  scheduled[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(spotlightRuns, 2);
  assert.deepEqual(errors, [recoveryFailure]);
  assert.equal(await scheduler.stopAndDrain(1_000), "drained");
});

test("stopAndDrain times out without starting a replacement delivery", async () => {
  const releaseSpotlight = deferred();
  const scheduled: Array<() => void> = [];
  let spotlightRuns = 0;

  const scheduler = createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      spotlightRuns += 1;
      await releaseSpotlight.promise;
    },
    runWelcomeRecovery: async () => {},
    onSpotlightError: () => assert.fail("spotlight recovery should not fail"),
    onWelcomeError: () => assert.fail("welcome recovery should not fail"),
    setInterval: (callback) => {
      scheduled.push(callback);
      return {} as ReturnType<typeof globalThis.setInterval>;
    },
  });

  scheduler.start();
  const drain = scheduler.stopAndDrain(0);
  scheduled[0]?.();

  assert.equal(await drain, "timed_out");
  assert.equal(spotlightRuns, 1);

  scheduled[0]?.();
  assert.equal(spotlightRuns, 1, "shutdown rejects stale timer callbacks");

  releaseSpotlight.resolve();
});
