import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecoveryScheduler,
  SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS,
  WELCOME_EMAIL_RECOVERY_INTERVAL_MS,
  type RecoveryClearInterval,
  type RecoverySetInterval,
} from "./recoveryScheduler";

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


test("stop clears both recovery timers", () => {
  const scheduled: Array<ReturnType<typeof globalThis.setInterval>> = [];
  const cleared: Array<ReturnType<typeof globalThis.setInterval>> = [];

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
    runSpotlightRecovery: async () => {},
    runWelcomeRecovery: async () => {},
    onSpotlightError: () => {},
    onWelcomeError: () => {},
    setInterval,
    clearInterval,
  });

  scheduler.start();
  scheduler.stop();
  scheduler.stop();

  assert.equal(scheduled.length, 2);
  assert.deepEqual(cleared, scheduled);
});