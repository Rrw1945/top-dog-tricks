import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createFailureReport } from "./api-typecheck-failure-report.mjs";

const moduleUrl = new URL("./api-typecheck-failure-report.mjs", import.meta.url).href;

test("nested aggregates and causes retain all records without private properties", () => {
  const makeRecord = (phase) => ({
    schemaVersion: 1, phase, canonicalOutput: "/output", transition: true,
    ownerStatus: "reused", token: "SECRET_TOKEN", processIdentity: "SECRET_ID",
    owner: { token: "SECRET_TOKEN" },
    filesystemState: {
      lockDirectory: { path: "/lock", remains: true, token: "SECRET_TOKEN" },
      ownerFile: { path: "/lock/owner.json", remains: false },
    },
  });
  const records = ["acquire", "recovery", "cleanup"].map(makeRecord);
  const leaves = records.map((lockDiagnostic) =>
    Object.assign(new Error("SECRET_MESSAGE"), { lockDiagnostic, lockDiagnostics: [lockDiagnostic] }));
  const nested = new AggregateError([leaves[1], leaves[2], "SECRET_PRIMITIVE"]);
  const error = new AggregateError([leaves[0], new Error("wrapper", { cause: nested })]);
  // A pre-collected partial list must not suppress traversal.
  error.lockDiagnostics = [records[0]];
  leaves[2].cause = error;
  const report = createFailureReport(error);
  assert.deepEqual(report.lockDiagnostics.map((r) => r.phase), ["acquire", "recovery", "cleanup"]);
  assert.equal(report.lockDiagnostics[2].filesystemState.ownerFile.remains, false);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|processIdentity|"token"|"owner"/);
  assert.deepEqual(createFailureReport(null), { schemaVersion: 1, status: "failed", lockDiagnostics: [] });
});

test("CLI monitor preserves failure output and exit, and publishes atomic JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "failure-report-"));
  try {
    const destination = path.join(directory, "nested", "report.json");
    const source = `
      import { installFailureReport } from ${JSON.stringify(moduleUrl)};
      installFailureReport();
      await Promise.reject(Object.assign(new Error("original failure"), {
        lockDiagnostic: { phase: "transition-lock-release", transition: true,
          ownerStatus: "dead", token: "SECRET_TOKEN", processIdentity: "SECRET_ID" }
      }));
    `;
    const run = (args, code = source) => spawnSync(process.execPath,
      ["--input-type=module", "-e", code, "--", ...args], { encoding: "utf8" });
    // With -e, script args start at index 1 instead of the CLI's normal index 2.
    const args = ["fixture"];
    const baseline = run(args);
    const enabled = run([...args, "--failure-report", destination]);
    assert.equal(enabled.status, baseline.status);
    assert.notEqual(enabled.status, 0);
    assert.equal(enabled.stderr, baseline.stderr);
    assert.match(enabled.stderr, /original failure/);
    const report = JSON.parse(await readFile(destination, "utf8"));
    assert.equal(report.lockDiagnostics[0].phase, "transition-lock-release");
    assert.doesNotMatch(JSON.stringify(report), /SECRET/);
    assert.deepEqual(await readdir(path.dirname(destination)), ["report.json"]);
    const success = run([...args, `--failure-report=${path.join(directory, "success.json")}`],
      `import { installFailureReport } from ${JSON.stringify(moduleUrl)}; installFailureReport();`);
    assert.equal(success.status, 0);
    assert.deepEqual(await readdir(directory), ["nested"]);
    const unwritable = run([...args, "--failure-report", directory]);
    assert.equal(unwritable.status, baseline.status);
    assert.match(unwritable.stderr, /Could not write JSON report/);
    assert.match(unwritable.stderr, /original failure/);
    assert.deepEqual(await readdir(directory), ["nested"]);
    assert.match(run([...args, "--failure-report"]).stderr, /nonempty path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real harness reports startup failures without changing stderr", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-report-"));
  try {
    const destination = path.join(directory, "report.json");
    const script = new URL("./check-api-typecheck-rebuilds-db.mjs", import.meta.url);
    const { fileURLToPath } = await import("node:url");
    // This fixture rejects missing inputs before it acquires or mutates locks.
    const args = [fileURLToPath(script), "--run-recovery-lock-handoff-fixture"];
    const env = { ...process.env, API_TYPECHECK_TEST_RECOVERY_HANDOFF_PATH: "" };
    const baseline = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    const reported = spawnSync(process.execPath, [...args, `--failure-report=${destination}`],
      { env, encoding: "utf8" });
    assert.notEqual(baseline.status, 0);
    assert.equal(reported.status, baseline.status);
    assert.equal(reported.stderr, baseline.stderr);
    assert.match(reported.stderr, /Recovery lock handoff fixture requires/);
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")),
      { schemaVersion: 1, status: "failed", lockDiagnostics: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Use the same source for baseline and monitored runs so Node's rendered stack
// (including the source excerpt) must remain byte-for-byte identical.
const publicationSource = `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  const [mode, destination, fault] = process.argv.slice(1);
  const marker = "PRIVATE_FILESYSTEM_ERROR";
  if (fault === "write") {
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      write(file, ...args);
      throw new Error(marker);
    };
  }
  if (fault === "rename") {
    fs.renameSync = () => { throw new Error(marker); };
  }
  syncBuiltinESMExports();
  const { installFailureReport } = await import(${JSON.stringify(moduleUrl)});
  if (mode === "enabled") installFailureReport(["--failure-report", destination]);
  console.log("original stdout");
  throw Object.assign(new Error("original publication fixture failure"), {
    lockDiagnostic: { phase: "publication-fixture", ownerStatus: "dead" }
  });
`;

function runPublication(mode, destination, fault = "") {
  const result = spawnSync(process.execPath,
    ["--input-type=module", "-e", publicationSource, "--", mode, destination, fault],
    { encoding: "utf8", timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  return result;
}

const publicationWarning =
  "[failure report] Could not write JSON report; original failure follows.\n";

for (const scenario of ["replace", "parent-file", "destination-directory", "write", "rename"]) {
  test(`uncaught failure publication: ${scenario}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "failure-publication-"));
    const oldReport = '{"status":"old report must survive failed publication"}\n';
    let destination = path.join(directory, "report.json");
    try {
      if (scenario === "parent-file") {
        const parent = path.join(directory, "blocked-parent");
        await writeFile(parent, oldReport);
        destination = path.join(parent, "report.json");
      } else if (scenario === "destination-directory") {
        await mkdir(destination);
        await writeFile(path.join(destination, "keep.txt"), oldReport);
      } else {
        await writeFile(destination, oldReport);
      }
      const fault = ["write", "rename"].includes(scenario) ? scenario : "";
      const baseline = runPublication("baseline", destination, fault);
      const enabled = runPublication("enabled", destination, fault);
      assert.equal(enabled.status, baseline.status);
      assert.equal(enabled.stdout, baseline.stdout);
      assert.match(baseline.stderr, /original publication fixture failure/);
      assert.equal(enabled.stderr,
        (scenario === "replace" ? "" : publicationWarning) + baseline.stderr);
      assert.doesNotMatch(enabled.stderr, /PRIVATE_FILESYSTEM_ERROR/);
      // A directory destination forces a real native rename failure; a file
      // parent forces a real mkdir failure without relying on platform ACLs.
      // Injection also covers a partial write and replacement rename failure.
      if (scenario === "replace") {
        const report = JSON.parse(await readFile(destination, "utf8"));
        assert.equal(report.status, "failed");
        assert.equal(report.lockDiagnostics[0].phase, "publication-fixture");
      } else if (scenario === "parent-file") {
        assert.equal(await readFile(path.dirname(destination), "utf8"), oldReport);
      } else if (scenario === "destination-directory") {
        assert.deepEqual(await readdir(destination), ["keep.txt"]);
        assert.equal(await readFile(path.join(destination, "keep.txt"), "utf8"), oldReport);
      } else {
        assert.equal(await readFile(destination, "utf8"), oldReport);
      }
      // Check the containing directory too: rename failures leave their staging
      // files beside (not inside) the intended destination unless cleaned up.
      assert.deepEqual(await readdir(directory),
        [scenario === "parent-file" ? "blocked-parent" : "report.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
