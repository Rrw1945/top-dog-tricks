import assert from "node:assert/strict";
import { createServer, request, Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.NODE_ENV = "production";

const { deliverSpotlightNotifications } = await import("./routes/submissions");
const { startApiServer } = await import("./apiServer");
const { startConfiguredApiServer } = await import("./apiServerEntrypoint");

const childMode = process.env["API_SHUTDOWN_CHILD_MODE"];

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function getFreePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0);
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

type ShutdownTestFiles = {
  starting: string;
  ready: string;
  spotlightStarted: string;
  welcomeStarted: string;
  analyticsStarted: string;
  release: string;
  claimed: string;
  inFlight: string;
  retrySkipped: string;
  claimAttempts: string;
  sendAttempts: string;
  deliveredAttempts: string;
  httpCloseCalls: string;
  requestStarted: string;
  requestAborted: string;
  shutdownStarted: string;
};

function getChildFiles(): ShutdownTestFiles {
  const root = process.env["API_SHUTDOWN_STATE_DIR"];
  if (!root) throw new Error("API_SHUTDOWN_STATE_DIR is required");
  return {
    starting: path.join(root, "starting"),
    ready: path.join(root, "ready"),
    spotlightStarted: path.join(root, "spotlight-started"),
    welcomeStarted: path.join(root, "welcome-started"),
    analyticsStarted: path.join(root, "analytics-started"),
    release: path.join(root, "release"),
    claimed: path.join(root, "claimed.json"),
    inFlight: path.join(root, "in-flight.json"),
    retrySkipped: path.join(root, "retry-skipped"),
    claimAttempts: path.join(root, "claim-attempts"),
    sendAttempts: path.join(root, "send-attempts"),
    deliveredAttempts: path.join(root, "delivered-attempts"),
    httpCloseCalls: path.join(root, "http-close-calls"),
    requestStarted: path.join(root, "request-started"),
    requestAborted: path.join(root, "request-aborted"),
    shutdownStarted: path.join(root, "shutdown-started"),
  };
}

async function waitForRelease(filePath: string): Promise<void> {
  await waitForFile(filePath, 60_000);
}

async function runChildRecovery(): Promise<void> {
  const files = getChildFiles();

  if (childMode === "startup-bind-error") {
    await writeFile(files.spotlightStarted, "");
    return;
  }

  if (childMode === "restart-disconnected") return;
  if (childMode === "welcome-reject") return;
  if (childMode === "analytics-reject" || childMode === "analytics-report-reject" || childMode === "analytics-timeout") return;

  if (childMode === "finish") {
    await writeFile(files.spotlightStarted, "");
    await waitForRelease(files.release);
    await appendFile(files.spotlightStarted, "-finished");
    return;
  }

  if (childMode === "reject") {
    await writeFile(files.spotlightStarted, "");
    await waitForRelease(files.release);
    throw new Error("shutdown recovery failure");
  }

  if (childMode === "retry") {
    await deliverSpotlightNotifications(
      { id: 1, trickName: "Shutdown test" },
      "https://top-dog-tricks.example",
      () => {},
      {
        listEligibleSubscribers: async () => [
          { id: 7, email: "shutdown-test@example.com" },
        ],
        claimDelivery: async () => {
          const state = JSON.parse(await readFile(files.claimed, "utf8")) as {
            idempotencyKey: string;
            status: string;
          };
          assert.equal(state.status, "claimed");
          await writeFile(files.retrySkipped, state.idempotencyKey);
          return null;
        },
        markDelivered: async () => {
          throw new Error("a claimed delivery must not be finalized twice");
        },
        markFailed: async () => {},
        sendNotification: async () => {
          throw new Error("a claimed delivery must not be sent twice");
        },
        createToken: () => "shutdown-test-token",
      },
    );
    return;
  }

  await writeFile(files.spotlightStarted, "");
  await deliverSpotlightNotifications(
    { id: 1, trickName: "Shutdown test" },
    "https://top-dog-tricks.example",
    () => {},
    {
      listEligibleSubscribers: async () => [
        { id: 7, email: "shutdown-test@example.com" },
      ],
      claimDelivery: async () => {
        if (childMode === "signals") {
          await appendFile(files.claimAttempts, "claim\n");
        }
        let state: { idempotencyKey: string; status: string } | undefined;
        try {
          state = JSON.parse(await readFile(files.claimed, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        if (state?.status === "claimed") {
          await writeFile(files.retrySkipped, state.idempotencyKey);
          return null;
        }

        const nextState = {
          idempotencyKey: "spotlight-notification-42",
          status: "claimed",
        };
        await writeFile(files.claimed, JSON.stringify(nextState));
        return 42;
      },
      markDelivered: async () => {
        if (childMode === "signals") {
          await appendFile(files.deliveredAttempts, "delivered\n");
          return;
        }
        throw new Error("the forced shutdown must not finalize the delivery");
      },
      markFailed: async () => {},
      sendNotification: async (
        _email,
        _trickName,
        _showcaseUrl,
        _unsubscribeUrl,
        idempotencyKey,
      ) => {
        if (childMode === "signals") {
          await appendFile(files.sendAttempts, "send\n");
        }
        await writeFile(files.inFlight, idempotencyKey);
        if (childMode === "signals") {
          await waitForRelease(files.release);
        } else {
          await new Promise<void>(() => {});
        }
      },
      createToken: () => "shutdown-test-token",
    },
  );
}

async function runChildWelcomeRecovery(): Promise<void> {
  const files = getChildFiles();
  if (childMode === "analytics-reject" || childMode === "analytics-report-reject" || childMode === "analytics-timeout") return;
  if (childMode === "restart-disconnected") return;
  await writeFile(files.welcomeStarted, "");

  if (childMode === "signals") {
    await waitForRelease(files.release);
    return;
  }
  if (childMode === "finish") {
    await waitForRelease(files.release);
    await appendFile(files.welcomeStarted, "-finished");
    return;
  }

  if (childMode === "welcome-reject") {
    await waitForRelease(files.release);
    throw new Error("welcome shutdown recovery failure");
  }

  if (childMode === "reject") return;
  if (childMode === "retry") return;
  await new Promise<void>(() => {});
}

if (childMode) {
  const files = getChildFiles();
  if (childMode === "signals") {
    const originalClose = Server.prototype.close;
    Server.prototype.close = function (callback) {
      appendFileSync(files.httpCloseCalls, "close\n");
      return originalClose.call(this, callback);
    };
  }
  if (childMode === "invalid-config") {
    startConfiguredApiServer();
  } else if (childMode === "http-error" || childMode === "http-error-timeout") {
    const api = startApiServer({
      recoverSpotlightNotifications: async () => {
        await writeFile(files.spotlightStarted, "");
        if (childMode === "http-error-timeout") {
          await new Promise<void>(() => {});
        } else {
          await waitForRelease(files.release);
          await appendFile(files.spotlightStarted, "-finished");
        }
      },
      recoverWelcomeEmails: async () => {},
      getPublicBaseUrl: () => "https://top-dog-tricks.example",
      recoveryShutdownGraceMs: 3_000,
      httpShutdownGraceMs: 100,
      logger: {
        info: (details, message) => {
          process.stdout.write(`${JSON.stringify({ details, message })}\n`);
        },
        error: (_details, message) => {
          process.stderr.write(`${message}\n`);
        },
      },
      onListening: () => { void writeFile(files.ready, ""); },
    });
    const originalClose = api.server.close.bind(api.server);
    api.server.close = (callback) => originalClose(() => {
      appendFileSync(files.httpCloseCalls, "close\n");
      callback?.(new Error("injected HTTP close failure"));
    });
    process.on("exit", (code) => {
      process.stdout.write(`${JSON.stringify({
        code,
        listening: api.server.listening,
        sigintHandlers: process.listenerCount("SIGINT"),
        sigtermHandlers: process.listenerCount("SIGTERM"),
      })}\n`);
    });
  } else if (childMode === "configured") {
    startConfiguredApiServer({
      recoverSpotlightNotifications: async () => {},
      recoverWelcomeEmails: async () => {},
      getPublicBaseUrl: () => "https://top-dog-tricks.example",
      logger: {
        info: (details, message) => {
          process.stdout.write(`${JSON.stringify({ details, message })}\n`);
        },
        error: (details, message) => {
          process.stdout.write(`${JSON.stringify({ details, message })}\n`);
        },
      },
      onListening: () => {
        void writeFile(files.ready, "");
      },
    });
  } else {
    if (childMode === "startup" || childMode === "startup-bind-error") {
      const { default: app } = await import("./app");
      assert.equal(
        Reflect.set(app, "listen", (port: number, callback?: () => void) => {
          const server = createServer(app);
          if (childMode === "startup-bind-error") {
            void waitForRelease(files.release).then(() =>
              server.listen(port, callback),
            );
          } else {
            setTimeout(() => server.listen(port, callback), 500);
          }
          return server;
        }),
        true,
      );
    }

    const logger =
      childMode === "restart-disconnected"
        ? {
            info: (details: unknown, message: string) => {
              process.stdout.write(`${JSON.stringify({ details, message })}\n`);
              if (message === "Shutting down server") {
                void writeFile(files.shutdownStarted, "");
              }
            },
            error: (details: unknown, message: string) => {
              process.stdout.write(`${JSON.stringify({ details, message })}\n`);
            },
          }
        : {
            info: (_details: unknown, message: string) => {
              if (childMode === "startup-bind-error" && message === "Shutting down server") {
                appendFileSync(files.shutdownStarted, "");
              }
              if ((childMode === "analytics-reject" || childMode === "analytics-report-reject") && message === "Shutting down server") {
                appendFileSync(files.shutdownStarted, "");
              }
            },
            error: (details: unknown, message: string) => {
              if (childMode === "analytics-report-reject") {
                console.error(JSON.stringify({ message, details }, (_key, value) =>
                  value instanceof Error ? { message: value.message } : value,
                ));
              }
              if (childMode === "analytics-timeout") {
                console.error(JSON.stringify({ details, message }));
              }
              if (childMode === "startup-bind-error") {
                console.error(message, details);
              }
              if (childMode === "reject" || childMode === "welcome-reject" || childMode === "analytics-reject") {
                console.error(message, details);
              }
            },
          };

    const apiServer = startApiServer({
      recoverSpotlightNotifications: async () => runChildRecovery(),
      recoverWelcomeEmails: async () => runChildWelcomeRecovery(),
      ...(childMode === "analytics-report-reject" ? {
        getNewsletterFunnelReport: async () => {
          await writeFile(files.analyticsStarted, "");
          await waitForRelease(files.release);
          throw new Error("analytics report shutdown failure");
        },
        notifyNewsletterCoverageRegressions: async () => {
          await appendFile(files.sendAttempts, "send\n");
          return false;
        },
      } : {}),
      ...(childMode === "startup-bind-error" ? {
        getNewsletterFunnelReport: async () => {
          await writeFile(files.analyticsStarted, "");
          throw new Error("Analytics must not start during interrupted startup");
        },
      } : {}),
      ...(childMode === "analytics-reject" || childMode === "analytics-timeout" ? {
        getNewsletterFunnelReport: async () => ({
          reportAsOf: "2026-10-11",
          coverage: {
            startDate: null,
            status: "unavailable" as const,
            auditTrail: [],
            cohorts: [],
            alerts: [],
          },
          native: {
            rows: [],
            comparison: {
              result: "unavailable",
              liftPoints: null,
              liftCi95LowerPoints: null,
              liftCi95UpperPoints: null,
            },
          },
          historical: { rows: [] },
        }),
        notifyNewsletterCoverageRegressions: async () => {
          if (childMode === "analytics-timeout") {
            // Model an open provider connection so natural event-loop exit
            // cannot masquerade as the forced shutdown deadline working.
            setInterval(() => {}, 1_000);
            await writeFile(files.analyticsStarted, "");
            return new Promise<boolean>(() => {});
          }
          await writeFile(files.analyticsStarted, "");
          await waitForRelease(files.release);
          throw new Error("analytics shutdown recovery failure");
        },
      } : {}),
      getPublicBaseUrl: () => "https://top-dog-tricks.example",
      logger,
      recoveryShutdownGraceMs: childMode === "signals" || childMode === "analytics-reject" || childMode === "analytics-report-reject" ? 3_000 : 100,
      httpShutdownGraceMs: childMode === "restart-disconnected" ? 5_000 : 100,
      onListening: () => {
        void writeFile(files.ready, "");
      },
    });

    if (childMode === "restart-disconnected") {
      apiServer.server.on("request", (request) => {
        if (request.method !== "POST" || request.url !== "/api/submissions") {
          return;
        }
        void writeFile(files.requestStarted, "");
        request.once("aborted", () => {
          void writeFile(files.requestAborted, "");
        });
      });
    }

    if (childMode === "startup-bind-error") {
      process.on("exit", () => {
        process.stdout.write(`${JSON.stringify({
          listening: apiServer.server.listening,
          sigintHandlers: process.listenerCount("SIGINT"),
          sigtermHandlers: process.listenerCount("SIGTERM"),
        })}\n`);
      });
    }

    if (childMode === "startup" || childMode === "startup-bind-error") {
      await writeFile(files.starting, "");
    }
  }
} else {
  function spawnApi(
    mode:
      | "finish"
      | "http-error"
      | "http-error-timeout"
      | "timeout"
      | "retry"
      | "reject"
      | "welcome-reject"
      | "analytics-reject"
      | "analytics-report-reject"
      | "analytics-timeout"
      | "signals"
      | "invalid-config"
      | "configured"
      | "startup"
      | "startup-bind-error"
      | "restart-disconnected",
    stateDir: string,
    port: number,
    recoveryShutdownGraceMs?: string,
    httpShutdownGraceMs?: string,
  ): ChildProcess {
    return spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...(mode === "analytics-report-reject"
          ? {
              NODE_ENV: "production",
              DATABASE_URL: "postgresql://test:test@127.0.0.1:1/shutdown_test",
              // Imported clients require configuration, but no real credentials
              // or service endpoints should enter this isolated child.
              AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:1",
              AI_INTEGRATIONS_OPENAI_API_KEY: "shutdown-test",
              AI_INTEGRATIONS_GEMINI_BASE_URL: "http://127.0.0.1:1",
              AI_INTEGRATIONS_GEMINI_API_KEY: "shutdown-test",
            }
          : process.env),
        API_SHUTDOWN_CHILD_MODE: mode,
        API_SHUTDOWN_STATE_DIR: stateDir,
        PORT: String(port),
        // Enable only the injected analytics fixture; never call a real provider.
        CLICKHOUSE_URL: mode === "analytics-reject" || mode === "analytics-report-reject" || mode === "analytics-timeout" ? "https://analytics.invalid" : "",
        ...(recoveryShutdownGraceMs === undefined
          ? {}
          : { RECOVERY_SHUTDOWN_GRACE_MS: recoveryShutdownGraceMs }),
        ...(httpShutdownGraceMs === undefined
          ? {}
          : { HTTP_SHUTDOWN_GRACE_MS: httpShutdownGraceMs }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async function assertHealthy(
    port: number,
    child: ChildProcess,
    label: string,
    timeoutMs = 5_000,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
    } catch (cause) {
      const exited = child.exitCode !== null || child.signalCode !== null;
      throw new Error(
        `Health probe ${controller.signal.aborted ? `timed out after ${timeoutMs}ms` : "failed"} for API child "${label}" (pid=${child.pid}, port=${port}, exited=${exited}, exitCode=${child.exitCode}, signalCode=${child.signalCode})`,
        { cause },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  for (const mode of ["http-error", "http-error-timeout"] as const) {
    test(`${mode} exits unsuccessfully after shutdown cleanup`, { timeout: 15_000 }, async () => {
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-http-error-"));
      const files = getChildFilesFor(stateDir);
      const child = spawnApi(mode, stateDir, await getFreePort());
      const childClosed = once(child, "close");
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk) => { stdout += chunk; });
      child.stderr!.on("data", (chunk) => { stderr += chunk; });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        await Promise.all([
          waitForFile(files.ready),
          waitForFile(files.spotlightStarted),
        ]);
        assert.equal(child.kill("SIGTERM"), true);
        await waitForFile(files.httpCloseCalls);
        assert.equal(child.exitCode, null, "HTTP failure must not skip recovery drain");
        if (mode === "http-error") await writeFile(files.release, "");

        assert.deepEqual(await childClosed, [1, null], `${stdout}\n${stderr}`);
        assert.match(stderr, /Error closing HTTP server/);
        assert.equal(await readFile(files.httpCloseCalls, "utf8"), "close\n");
        assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)!), {
          code: 1,
          listening: false,
          sigintHandlers: 0,
          sigtermHandlers: 0,
        });
        if (mode === "http-error") {
          assert.equal(await readFile(files.spotlightStarted, "utf8"), "-finished");
          assert.doesNotMatch(stderr, /Recovery deliveries did not finish/);
        } else {
          assert.match(stderr, /Recovery deliveries did not finish before shutdown grace period/);
        }
      } finally {
        clearTimeout(watchdog);
        child.kill("SIGKILL");
        await childClosed;
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  }

  for (const stalledStage of ["headers", "body"] as const) {
    test(`health probe bounds stalled ${stalledStage} and reports child status`, { timeout: 5_000 }, async () => {
      const child = spawn(process.execPath, [
        "-e",
        stalledStage === "headers" ? "setInterval(() => {}, 1000)" : "process.exit(7)",
      ], { stdio: "ignore" });
      const childClosed = once(child, "close");
      const server = createServer((_request, response) => {
        if (stalledStage === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"status":');
        }
        // Intentionally never finish the response.
      });
      try {
        if (stalledStage === "body") await childClosed;
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert(address && typeof address !== "string");
        await assert.rejects(
          assertHealthy(address.port, child, `stalled-${stalledStage}`, 250),
          (error: unknown) => {
            assert(error instanceof Error);
            assert.match(error.message, /Health probe timed out after 250ms/);
            assert(error.message.includes(`API child "stalled-${stalledStage}"`));
            assert(error.message.includes(`pid=${child.pid}, port=${address.port}`));
            assert(error.message.includes(
              stalledStage === "headers"
                ? "exited=false, exitCode=null, signalCode=null"
                : "exited=true, exitCode=7, signalCode=null",
            ));
            assert(error.cause instanceof Error);
            return true;
          },
        );
      } finally {
        child.kill("SIGKILL");
        await childClosed;
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => error ? reject(error) : resolve()),
          );
        }
      }
    });
  }

  type ShutdownSignal = "SIGINT" | "SIGTERM";

  async function assertShutdownDuringStartup(
    signal: ShutdownSignal,
  ): Promise<void> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
    const files = getChildFilesFor(stateDir);
    const port = await getFreePort();
    const child = spawnApi("startup", stateDir, port);
    const childExit = once(child, "exit");

    try {
      await waitForFile(files.starting);
      child.kill(signal);

      const [code, exitSignal] = await childExit;
      assert.equal(code, 0);
      assert.equal(exitSignal, null);
      await assert.rejects(access(files.ready));
      await assert.rejects(access(files.spotlightStarted));
      await assert.rejects(access(files.welcomeStarted));

      const probe = createServer();
      probe.listen(port);
      await once(probe, "listening");
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
    } finally {
      child.kill("SIGKILL");
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} closes the listener without starting recovery during startup`, async () => {
      await assertShutdownDuringStartup(signal);
    });

    test(`${signal} exits with a reported bind failure during interrupted startup`, { timeout: 10_000 }, async () => {
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-bind-error-"));
      const files = getChildFilesFor(stateDir);
      const port = await getFreePort();
      const blocker = createServer();
      const child = spawnApi("startup-bind-error", stateDir, port);
      const childExit = once(child, "exit");
      const childClosed = once(child, "close");
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk) => { stdout += chunk; });
      child.stderr!.on("data", (chunk) => { stderr += chunk; });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 8_000);

      try {
        await waitForFile(files.starting);
        assert.equal(child.kill(signal), true);
        await waitForFile(files.shutdownStarted);

        // Occupy the port only after shutdown is waiting for startup, then
        // release the delayed listen call to produce a real EADDRINUSE event.
        blocker.listen(port);
        await once(blocker, "listening");
        await writeFile(files.release, "");

        const [code, exitSignal] = await childExit;
        await childClosed;
        assert.equal(exitSignal, null, stderr);
        assert.equal(code, 1, stderr);
        assert.match(stderr, /Error listening on port/);
        assert.match(stderr, /EADDRINUSE/);
        assert.deepEqual(JSON.parse(stdout.trim()), {
          listening: false,
          sigintHandlers: 0,
          sigtermHandlers: 0,
        });
        for (const marker of [files.ready, files.spotlightStarted, files.welcomeStarted, files.analyticsStarted]) {
          await assert.rejects(access(marker), { code: "ENOENT" });
        }
      } finally {
        clearTimeout(watchdog);
        child.kill("SIGKILL");
        await childClosed;
        if (blocker.listening) {
          await new Promise<void>((resolve, reject) =>
            blocker.close((error) => error ? reject(error) : resolve()),
          );
        }
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  }

  test("an invalid recovery shutdown grace setting stops API startup with a clear error", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
    const port = await getFreePort();
    const child = spawnApi("invalid-config", stateDir, port, "99");
    const childExit = once(child, "exit");
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

    try {
      const [code, exitSignal] = await childExit;
      assert.equal(code, 1);
      assert.equal(exitSignal, null);
      assert.match(
        stderr.join(""),
        /RECOVERY_SHUTDOWN_GRACE_MS must be an integer from 100 to 300000 milliseconds; received "99"/,
      );
      await assert.rejects(access(getChildFilesFor(stateDir).ready));
    } finally {
      child.kill("SIGKILL");
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("invalid HTTP shutdown grace setting stops API startup with a clear error", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
    const port = await getFreePort();
    const child = spawnApi("invalid-config", stateDir, port, undefined, "99");
    const childExit = once(child, "exit");
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

    try {
      const [code, exitSignal] = await childExit;
      assert.equal(code, 1);
      assert.equal(exitSignal, null);
      assert.match(
        stderr.join(""),
        /HTTP_SHUTDOWN_GRACE_MS must be an integer from 100 to 300000 milliseconds; received "99"/,
      );
      await assert.rejects(access(getChildFilesFor(stateDir).ready));
    } finally {
      child.kill("SIGKILL");
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("configured shutdown grace settings are included in the structured shutdown log", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
    const files = getChildFilesFor(stateDir);
    const port = await getFreePort();
    const child = spawnApi("configured", stateDir, port, "250", "175");
    const stdout: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    const childExit = once(child, "exit");

    try {
      await waitForFile(files.ready);
      await assertHealthy(port, child, "configured");

      child.kill("SIGTERM");

      const [code, exitSignal] = await childExit;
      assert.equal(code, 0);
      assert.equal(exitSignal, null);

      const shutdownLog = stdout
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          details: { recoveryGraceMs?: number; httpGraceMs?: number };
          message: string;
        })
        .find((entry) => entry.message === "Shutting down server");
      assert.deepEqual(shutdownLog, {
        details: {
          signal: "SIGTERM",
          recoveryGraceMs: 250,
          httpGraceMs: 175,
        },
        message: "Shutting down server",
      });
    } finally {
      child.kill("SIGKILL");
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("clients reconnect after a clean API restart following an aborted request", async () => {
    const firstStateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
    const restartedStateDir = await mkdtemp(
      path.join(os.tmpdir(), "api-shutdown-restarted-"),
    );
    const firstFiles = getChildFilesFor(firstStateDir);
    const restartedFiles = getChildFilesFor(restartedStateDir);
    const port = await getFreePort();
    const firstServer = spawnApi(
      "restart-disconnected",
      firstStateDir,
      port,
      undefined,
      "5000",
    );
    const firstOutput: string[] = [];
    firstServer.stdout?.on("data", (chunk: Buffer) =>
      firstOutput.push(chunk.toString()),
    );
    const firstStderr: string[] = [];
    firstServer.stderr?.on("data", (chunk: Buffer) =>
      firstStderr.push(chunk.toString()),
    );
    const firstExit = once(firstServer, "exit");
    let clientRequest: ReturnType<typeof request> | undefined;
    let restartedServer: ChildProcess | undefined;

    try {
      await waitForFile(firstFiles.ready);

      clientRequest = request({
        host: "127.0.0.1",
        path: "/api/submissions",
        port,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "10000",
        },
      });
      clientRequest.on("error", () => {});
      clientRequest.write('{"ownerName":"disconnected');
      await waitForFile(firstFiles.requestStarted);

      firstServer.kill("SIGTERM");
      await waitForFile(firstFiles.shutdownStarted);
      clientRequest.destroy();
      await waitForFile(firstFiles.requestAborted);

      assert.deepEqual(await firstExit, [0, null]);
      assert.match(
        firstOutput.join(""),
        /HTTP server closed cleanly before shutdown grace period/,
      );
      assert.doesNotMatch(
        firstOutput.join(""),
        /HTTP server did not close before shutdown grace period|Error closing HTTP server|Error force-closing HTTP connections/,
      );
      assert.equal(firstStderr.join(""), "");

      restartedServer = spawnApi("configured", restartedStateDir, port);
      const restartedExit = once(restartedServer, "exit");
      await waitForFile(restartedFiles.ready);
      await assertHealthy(port, restartedServer, "restarted");

      restartedServer.kill("SIGTERM");
      assert.deepEqual(await restartedExit, [0, null]);
    } finally {
      clientRequest?.destroy();
      firstServer.kill("SIGKILL");
      restartedServer?.kill("SIGKILL");
      await Promise.all([
        rm(firstStateDir, { recursive: true, force: true }),
        rm(restartedStateDir, { recursive: true, force: true }),
      ]);
    }
  });

  test("several clean API restarts keep accepting health requests on the same port", { timeout: 45_000 }, async () => {
    const port = await getFreePort();

    // Initial start plus three restarts, with a distinct readiness marker for
    // each process so an earlier cycle cannot make the next one appear ready.
    for (let cycle = 1; cycle <= 4; cycle++) {
      const label = `restart cycle ${cycle}`;
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-restart-cycle-"));
      const child = spawnApi("configured", stateDir, port, "1000", "1000");
      const childClosed = once(child, "close");
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk) => { stdout += chunk; });
      child.stderr!.on("data", (chunk) => { stderr += chunk; });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);

      try {
        await waitForFile(getChildFilesFor(stateDir).ready);
        await assertHealthy(port, child, label);
        assert.equal(child.kill("SIGTERM"), true, label);

        // Wait for stdio to finish as well as process exit before inspecting
        // shutdown logs or rebinding the port in the following cycle.
        assert.deepEqual(await childClosed, [0, null], `${label}: ${stdout}\n${stderr}`);
        assert.match(
          stdout,
          /HTTP server closed cleanly before shutdown grace period/,
          label,
        );
        assert.doesNotMatch(
          stdout,
          /forcing connections closed|Error |did not finish before shutdown grace period|did not close before shutdown grace period/,
          label,
        );
        assert.equal(stderr, "", label);
      } finally {
        clearTimeout(watchdog);
        child.kill("SIGKILL");
        await childClosed;
        await rm(stateDir, { recursive: true, force: true });
      }
    }
  });

  async function assertRecoveryDrains(signal: ShutdownSignal): Promise<void> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
    const files = getChildFilesFor(stateDir);
    const port = await getFreePort();
    const child = spawnApi("finish", stateDir, port);
    const childExit = once(child, "exit");

    try {
      await waitForFile(files.ready);
      await assertHealthy(port, child, "finish");
      await Promise.all([
        waitForFile(files.spotlightStarted),
        waitForFile(files.welcomeStarted),
      ]);

      child.kill(signal);
      await writeFile(files.release, "");

      const [code, exitSignal] = await childExit;
      assert.equal(code, 0);
      assert.equal(exitSignal, null);
      assert.match(
        await readFile(files.spotlightStarted, "utf8"),
        /-finished$/,
      );
      assert.match(await readFile(files.welcomeStarted, "utf8"), /-finished$/);
    } finally {
      child.kill("SIGKILL");
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  async function assertRecoveryForceExits(
    signal: ShutdownSignal,
  ): Promise<void> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
    const files = getChildFilesFor(stateDir);
    const port = await getFreePort();
    const child = spawnApi("timeout", stateDir, port);
    const childExit = once(child, "exit");

    try {
      await waitForFile(files.ready);
      await assertHealthy(port, child, "timeout");
      await Promise.all([
        waitForFile(files.spotlightStarted),
        waitForFile(files.welcomeStarted),
        waitForFile(files.inFlight),
      ]);

      child.kill(signal);
      const [code, exitSignal] = await childExit;
      assert.equal(code, 0);
      assert.equal(exitSignal, null);
      assert.equal(
        await readFile(files.inFlight, "utf8"),
        "spotlight-notification-42",
      );
      assert.equal(
        await readFile(files.claimed, "utf8"),
        JSON.stringify({
          idempotencyKey: "spotlight-notification-42",
          status: "claimed",
        }),
      );

      const retryPort = await getFreePort();
      const retry = spawnApi("retry", stateDir, retryPort);
      const retryExit = once(retry, "exit");
      try {
        await waitForFile(files.retrySkipped);
        retry.kill(signal);
        const [retryCode, retrySignal] = await retryExit;
        assert.equal(retryCode, 0);
        assert.equal(retrySignal, null);
        assert.equal(
          await readFile(files.retrySkipped, "utf8"),
          "spotlight-notification-42",
        );
      } finally {
        retry.kill("SIGKILL");
      }
    } finally {
      child.kill("SIGKILL");
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  async function assertAnalyticsTimeoutExits(
    signal: ShutdownSignal,
  ): Promise<void> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-analytics-shutdown-"));
    const files = getChildFilesFor(stateDir);
    const child = spawnApi("analytics-timeout", stateDir, await getFreePort());
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    const childClosed = once(child, "close");
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      child.kill("SIGKILL");
    }, 10_000);

    try {
      await waitForFile(files.ready);
      await waitForFile(files.analyticsStarted);
      // Neither neighboring recovery is allowed to cause the timeout.
      await assert.rejects(access(files.spotlightStarted), { code: "ENOENT" });
      await assert.rejects(access(files.welcomeStarted), { code: "ENOENT" });

      assert.equal(child.kill(signal), true);
      const [code, exitSignal] = await childClosed;
      assert.equal(watchdogFired, false, "analytics shutdown must beat the watchdog");
      assert.equal(code, 0, stderr.join(""));
      assert.equal(exitSignal, null);
      const logs = stderr.join("").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(logs, [{
        details: { graceMs: 100 },
        message: "Recovery deliveries did not finish before shutdown grace period",
      }]);
      await assert.rejects(access(files.release), { code: "ENOENT" });
    } finally {
      clearTimeout(watchdog);
      child.kill("SIGKILL");
      await childClosed;
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  async function assertRecoveryRejectionDoesNotBlockShutdown(
    signal: ShutdownSignal,
    recovery: "spotlight" | "welcome" | "analytics" | "analytics-report" = "spotlight",
  ): Promise<void> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
    const files = getChildFilesFor(stateDir);
    const port = await getFreePort();
    const isAnalytics = recovery === "analytics" || recovery === "analytics-report";
    const mode = recovery === "analytics-report" ? "analytics-report-reject" : recovery === "analytics" ? "analytics-reject" : recovery === "welcome" ? "welcome-reject" : "reject";
    const startedFile =
      isAnalytics ? files.analyticsStarted : recovery === "welcome" ? files.welcomeStarted : files.spotlightStarted;
    const expectedLog =
      isAnalytics
        ? /Scheduled analytics coverage notification failed/
        : recovery === "welcome"
        ? /Scheduled welcome email recovery failed/
        : /Scheduled spotlight notification recovery failed/;
    const expectedError =
      recovery === "analytics-report"
        ? /analytics report shutdown failure/
        : recovery === "analytics"
        ? /analytics shutdown recovery failure/
        : recovery === "welcome"
        ? /welcome shutdown recovery failure/
        : /shutdown recovery failure/;
    const child = spawnApi(mode, stateDir, port);
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    const childExit = once(child, "close");
    const exitTimeout = setTimeout(() => child.kill("SIGKILL"), 10_000);

    try {
      await waitForFile(files.ready);
      await assertHealthy(port, child, mode);
      await waitForFile(startedFile);

      assert.equal(child.kill(signal), true);
      if (isAnalytics) await waitForFile(files.shutdownStarted);
      await writeFile(files.release, "");

      const [code, exitSignal] = await childExit;
      assert.equal(code, 0);
      assert.equal(exitSignal, null);
      assert.match(stderr.join(""), expectedLog);
      assert.match(stderr.join(""), expectedError);
      if (recovery === "analytics-report") {
        const failureLog = stderr.join("").trim().split("\n")
          .map((line) => JSON.parse(line))
          .find((entry) => entry.message === "Scheduled analytics coverage notification failed");
        assert.ok(failureLog, "analytics failure must be logged");
        assert.match(JSON.stringify(failureLog.details), expectedError);
        await assert.rejects(access(files.sendAttempts), { code: "ENOENT" });
      }
      assert.doesNotMatch(stderr.join(""), /Recovery deliveries did not finish before shutdown grace period/);
    } finally {
      clearTimeout(exitTimeout);
      child.kill("SIGKILL");
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} lets in-flight recovery finish before exiting`, async () => {
      await assertRecoveryDrains(signal);
    });
    test(`${signal} bounds stalled recovery without releasing its delivery claim`, async () => {
      await assertRecoveryForceExits(signal);
    });
    test(`${signal} reports the deadline and exits with only analytics notification stalled`, { timeout: 15_000 }, async () => {
      await assertAnalyticsTimeoutExits(signal);
    });
    for (const recovery of ["spotlight", "welcome", "analytics", "analytics-report"] as const) {
      test(`${signal} exits after ${recovery} recovery rejects`, async () => {
        await assertRecoveryRejectionDoesNotBlockShutdown(signal, recovery);
      });
    }
    test(`${signal} ignores repeated and mixed signals while draining recovery`, async () => {
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "api-shutdown-"));
      const files = getChildFilesFor(stateDir);
      const child = spawnApi("signals", stateDir, await getFreePort());
      const childExit = once(child, "exit");
      try {
        await Promise.all([
          waitForFile(files.ready),
          waitForFile(files.spotlightStarted),
          waitForFile(files.welcomeStarted),
          waitForFile(files.inFlight),
        ]);
        child.kill(signal);
        await waitForFile(files.httpCloseCalls);
        for (const nextSignal of [signal, signal === "SIGTERM" ? "SIGINT" : "SIGTERM"] as const) {
          child.kill(nextSignal);
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(child.exitCode, null);
          assert.equal(child.signalCode, null);
        }
        await writeFile(files.release, "");
        assert.deepEqual(await childExit, [0, null]);
        assert.equal(await readFile(files.httpCloseCalls, "utf8"), "close\n");
        assert.equal(await readFile(files.claimAttempts, "utf8"), "claim\n");
        assert.equal(await readFile(files.sendAttempts, "utf8"), "send\n");
        assert.equal(await readFile(files.deliveredAttempts, "utf8"), "delivered\n");
      } finally {
        child.kill("SIGKILL");
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  }
}

function getChildFilesFor(root: string): ShutdownTestFiles {
  return {
    starting: path.join(root, "starting"),
    ready: path.join(root, "ready"),
    spotlightStarted: path.join(root, "spotlight-started"),
    welcomeStarted: path.join(root, "welcome-started"),
    analyticsStarted: path.join(root, "analytics-started"),
    release: path.join(root, "release"),
    claimed: path.join(root, "claimed.json"),
    inFlight: path.join(root, "in-flight.json"),
    retrySkipped: path.join(root, "retry-skipped"),
    claimAttempts: path.join(root, "claim-attempts"),
    sendAttempts: path.join(root, "send-attempts"),
    deliveredAttempts: path.join(root, "delivered-attempts"),
    httpCloseCalls: path.join(root, "http-close-calls"),
    requestStarted: path.join(root, "request-started"),
    requestAborted: path.join(root, "request-aborted"),
    shutdownStarted: path.join(root, "shutdown-started"),
  };
}
