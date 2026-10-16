import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

// Exercise the actual attempt, without running the harness's top-level checks
// or touching shared generated outputs and recovery locks.
const source = await readFile(
  new URL("./check-api-typecheck-rebuilds-db.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("async function runInterruptedPublicationRecoveryAttempt(");
const end = source.indexOf("\nif (testInterruptedPublication)", start);
assert.ok(start >= 0 && end > start);
const attemptSource = source.slice(start, end);

for (const platform of ["linux", "win32"]) {
  for (const failurePhase of ["readiness", "recovery"]) {
    test(`${platform}: ${failurePhase} failure waits for publisher exit before fixture removal`, async () => {
      const events = [];
      const failure = new Error(`Injected ${failurePhase} failure`);
      const child = new EventEmitter();
      Object.assign(child, { pid: 12345, exitCode: null, signalCode: null });
      let terminationCount = 0;
      function terminate(target, signal) {
        assert.equal(target, platform === "win32" ? child.pid : -child.pid);
        assert.equal(signal, "SIGKILL");
        terminationCount += 1;
        events.push("signal");
        // Sending a signal does not synchronously confirm process exit.
        setImmediate(() => {
          child.signalCode = signal;
          events.push("exit");
          child.emit("exit", null, signal);
        });
        return true;
      }
      child.kill = (signal) => {
        assert.equal(platform, "win32");
        return terminate(child.pid, signal);
      };
      const fixtureDirectory = "/fixture/publication";
      const metadata = { mode: 0o640, mtimeMs: 1000 };
      const context = vm.createContext({
        path,
        process: {
          platform,
          kill: (target, signal) => {
            assert.notEqual(platform, "win32");
            return terminate(target, signal);
          },
        },
        workspaceRoot: "/fixture",
        mkdtemp: async () => fixtureDirectory,
        writeFile: async () => {},
        chmod: async () => {},
        utimes: async () => {},
        readGeneratedFileMetadata: async () => metadata,
        readGeneratedTreeMetadata: async () => [metadata],
        fingerprint: async () => ["original"],
        canonicalizePath: async (value) => value,
        createLockEntry: () => ({ lockDirectory: "/lock" }),
        runHarnessChild: (args) => {
          if (args[0] === "--run-interrupted-publication-fixture") return child;
          events.push("recovery");
          assert.notEqual(child.signalCode, null);
          return {};
        },
        waitForFile: async () => {
          if (failurePhase === "readiness") throw failure;
        },
        readJson: async () => ({
          creatingDirectory: "/staging",
          activeDirectory: "/active",
        }),
        exists: async (value) => value === "/staging",
        waitForChild: async () => { throw failure; },
        rm: async (value) => {
          assert.equal(value, fixtureDirectory);
          assert.ok(
            child.exitCode !== null || child.signalCode !== null,
            "Fixture removal raced with a live publisher",
          );
          events.push("remove");
        },
      });
      const attempt = vm.runInContext(
        `${attemptSource}\nrunInterruptedPublicationRecoveryAttempt`,
        context,
      );
      await assert.rejects(
        attempt(1, 2, new Set(), new Set(), "staging", false),
        (error) => error === failure,
      );
      assert.equal(terminationCount, 1, "Do not signal an already-exited publisher");
      assert.deepEqual(
        events,
        failurePhase === "readiness"
          ? ["signal", "exit", "remove"]
          : ["signal", "exit", "recovery", "remove"],
      );
    });
  }
}
