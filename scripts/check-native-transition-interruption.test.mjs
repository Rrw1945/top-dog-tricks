import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const probe = fileURLToPath(new URL("./check-api-typecheck-rebuilds-db.mjs", import.meta.url));

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

const deliveryModes = process.platform === "win32" ? ["listener"] : ["signal", "listener"];
for (const stage of ["startup", "live"]) {
for (const delivery of deliveryModes) {
for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} via ${delivery} during ${stage} stops the native owner and removes transition state`, { timeout: 60_000 }, async () => {
    const child = spawn(process.execPath, [probe, "--run-native-transition-interruption-fixture"], {
      env: {
        ...process.env,
        API_TYPECHECK_NATIVE_INTERRUPTION_STAGE: stage,
        API_TYPECHECK_NATIVE_INTERRUPTION_LISTENER: delivery === "listener" ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const exit = once(child, "exit");
    let fixture;
    let timer;
    try {
      fixture = await Promise.race([
        once(child, "message").then(([message]) => message),
        exit.then(() => { throw new Error(`Probe exited before ready: ${output}`); }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Probe readiness timed out: ${output}`)), 40_000);
        }),
      ]);
      clearTimeout(timer);
      assert.equal(fixture.stage, stage);
      assert.ok(isRunning(fixture.ownerPid), "owner must be alive before interruption");
      await access(fixture.transitionDirectory);
      await access(fixture.ownerPath);
      if (stage === "startup") {
        await assert.rejects(access(fixture.readyPath), { code: "ENOENT" });
      } else {
        await access(fixture.readyPath);
      }
      // POSIX tests deliver actual OS signals. Node on Windows cannot deliver
      // catchable signals with kill(), so IPC invokes the registered listener.
      if (delivery === "listener") child.send(signal);
      else assert.ok(child.kill(signal));
      const [code, exitSignal] = await Promise.race([
        exit,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Probe cleanup timed out: ${output}`)), 15_000);
        }),
      ]);
      assert.equal(exitSignal, null, output);
      assert.equal(code, signal === "SIGINT" ? 130 : 143, output);
      assert.equal(isRunning(fixture.ownerPid), false, "owner survived interruption");
      for (const target of [fixture.readyPath, fixture.ownerPath, fixture.transitionDirectory, fixture.testDirectory]) {
        await assert.rejects(access(target), { code: "ENOENT" });
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      if (fixture) {
        if (isRunning(fixture.ownerPid)) process.kill(fixture.ownerPid, "SIGKILL");
        await rm(fixture.transitionDirectory, { force: true, recursive: true });
        await rm(fixture.testDirectory, { force: true, recursive: true });
      }
    }
  });
}
}
}
