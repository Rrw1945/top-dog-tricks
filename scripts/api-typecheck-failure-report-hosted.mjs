// Isolated hosted experiment; never changes the required native workflow.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const native = (await readFile(path.join(root, ".github/workflows/native-process-identity.yml"), "utf8"))
  .replace(/\r\n/g, "\n");
const command = native.match(/run: (pnpm run check:api-typecheck-rebuilds-libs:process-identity:native --failure-report .+)/)?.[1];
const upload = native.split("      - name: Upload API typecheck failure reports\n")[1]?.trimEnd();
assert.ok(command && upload, "native report wiring must be available");
const mode = process.argv[2];

if (mode === "workflow") {
  const directory = native.match(/API_TYPECHECK_FAILURE_REPORT_DIR: (.+)/)[1]
    .replace("/generated-artifacts/", "/generated-artifacts/quoted path fixture/");
  const body = upload.replace("        if:", "        id: report-upload\n        if:");
  console.log(`name: Isolated native failure report experiment
on:
  push:
    branches: [test/native-failure-report-evidence]
  workflow_dispatch:
permissions:
  contents: read
  actions: read
jobs:
  process-identity:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest]
        node: [22, 24]
    runs-on: \${{ matrix.os }}
    timeout-minutes: 10
    env:
      API_TYPECHECK_FAILURE_REPORT_DIR: ${directory}
      API_TYPECHECK_TEST_RECOVERY_HANDOFF_PATH: ""
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout-cone-mode: false
          sparse-checkout: |
            /scripts/
            /.github/workflows/native-process-identity.yml
            /package.json
      - uses: pnpm/action-setup@v4
        with:
          version: 10
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - name: Restore earlier report on successful rerun
        if: \${{ github.run_attempt != '1' }}
        uses: actions/cache/restore@v4
        with:
          key: isolated-report-\${{ github.run_id }}-\${{ matrix.os }}-\${{ matrix.node }}
          path: earlier report
          fail-on-cache-miss: true
      - name: Prepare isolated harness package
        run: node scripts/api-typecheck-failure-report-hosted.mjs prepare
      - name: Run isolated harness with native command
        id: harness
        working-directory: isolated harness
        run: ${command}
      - name: Check report isolation and original outcome
        if: \${{ always() }}
        env:
          HARNESS_OUTCOME: \${{ steps.harness.outcome }}
          HARNESS_CONCLUSION: \${{ steps.harness.conclusion }}
        run: node scripts/api-typecheck-failure-report-hosted.mjs verify
      - name: Preserve first report for the rerun fixture
        if: \${{ always() && github.run_attempt == '1' }}
        uses: actions/cache/save@v4
        with:
          key: isolated-report-\${{ github.run_id }}-\${{ matrix.os }}-\${{ matrix.node }}
          path: earlier report
      - name: Upload API typecheck failure reports
${body}
      - name: Verify upload result
        if: \${{ always() }}
        env:
          REPORT_ARTIFACT_ID: \${{ steps.report-upload.outputs.artifact-id }}
          REPORT_UPLOAD_OUTCOME: \${{ steps.report-upload.outcome }}
        run: node scripts/api-typecheck-failure-report-hosted.mjs verify-upload
`);
} else {
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  assert.ok(Number.isInteger(attempt) && attempt > 0);
  const reportDir = process.env.API_TYPECHECK_FAILURE_REPORT_DIR;
  assert.ok(reportDir?.includes("quoted path fixture"));
  const expected = { schemaVersion: 1, status: "failed", lockDiagnostics: [] };
  if (mode === "prepare") {
    await mkdir(path.join(root, "isolated harness/scripts"), { recursive: true });
    const fixtureConfigs = {
      "tsconfig.json": { references: [] },
      "artifacts/api-server/tsconfig.json": { references: [{ path: "../../lib/fixture" }] },
      "lib/fixture/tsconfig.json": {
        compilerOptions: { composite: true, emitDeclarationOnly: true },
      },
      "lib/fixture/package.json": { name: "@fixture/declarations", private: true },
    };
    for (const [name, value] of Object.entries(fixtureConfigs)) {
      const destination = path.join(root, "isolated harness", name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, JSON.stringify(value));
    }
    for (const name of ["check-api-typecheck-rebuilds-db.mjs", "api-typecheck-failure-report.mjs"]) {
      await writeFile(path.join(root, "isolated harness/scripts", name),
        await readFile(path.join(root, "scripts", name)));
    }
    await writeFile(path.join(root, "isolated harness/package.json"), JSON.stringify({
      private: true, type: "module",
      scripts: {
        "check:api-typecheck-rebuilds-libs:process-identity:native":
          `node scripts/check-api-typecheck-rebuilds-db.mjs ${attempt === 1 ? "--run-recovery-lock-handoff-fixture" : "--test-process-identity"}`,
      },
    }));
    // Sibling JSON and non-JSON files must never enter the current artifact.
    await mkdir(reportDir, { recursive: true });
    await writeFile(path.join(reportDir, "not-a-report.txt"), "excluded");
    await writeFile(path.join(path.dirname(reportDir), "neighbor.json"), '{"excluded":true}');
  } else if (mode === "verify") {
    const outcome = attempt === 1 ? "failure" : "success";
    assert.equal(process.env.HARNESS_OUTCOME, outcome);
    assert.equal(process.env.HARNESS_CONCLUSION, outcome);
    const files = (await readdir(reportDir)).filter((name) => name.endsWith(".json"));
    assert.deepEqual(files, attempt === 1 ? ["native.json"] : []);
    if (attempt === 1) {
      const report = await readFile(path.join(reportDir, "native.json"), "utf8");
      assert.deepEqual(JSON.parse(report), expected);
      await mkdir(path.join(root, "earlier report"), { recursive: true });
      await writeFile(path.join(root, "earlier report/native.json"), report);
    } else {
      // Do not remove the stale report: absence from upload must come from scope.
      assert.deepEqual(await readdir(path.join(root, "earlier report")), ["native.json"]);
      assert.deepEqual(JSON.parse(await readFile(path.join(root, "earlier report/native.json"), "utf8")), expected);
    }
    console.log(JSON.stringify({ platform: process.platform, runtime: process.version, attempt, outcome, files }));
  } else if (mode === "verify-upload") {
    assert.equal(process.env.REPORT_UPLOAD_OUTCOME, "success");
    assert.equal(Boolean(process.env.REPORT_ARTIFACT_ID), attempt === 1);
  } else {
    throw new Error(`Unknown experiment mode: ${mode}`);
  }
}
