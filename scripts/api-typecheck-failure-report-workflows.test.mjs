import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkNativeProcessWorkflowCoverage } from "./check-node-support-matrix.mjs";

const readWorkflow = (name) =>
  readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");

for (const name of ["frontend-typecheck-refresh", "native-process-identity"]) {
  test(`${name}: each harness invocation has an isolated, collected report`, async () => {
    const workflow = await readWorkflow(name);
    const directory = workflow.match(/API_TYPECHECK_FAILURE_REPORT_DIR: (.+)/)?.[1];
    for (const scope of ["github.workspace", "github.run_id", "github.run_attempt", "matrix.node"]) {
      assert.ok(directory?.includes(`\${{ ${scope} }}`), scope);
    }
    // jobs.<job_id>.env cannot use runner/steps/env contexts. github.job is
    // step-only in value availability, so job identity is a literal here.
    const allowedContexts = new Set(["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"]);
    for (const [, context] of directory.matchAll(/\$\{\{\s*(\w+)\./g)) {
      assert.ok(allowedContexts.has(context), `invalid job env context: ${context}`);
    }
    assert.ok(!directory.includes("github.job"));
    assert.ok(directory.includes(name === "frontend-typecheck-refresh" ? "-standard-recovery-" : "-process-identity-"));
    if (name === "native-process-identity") {
      assert.ok(directory.includes("${{ matrix.os }}"));
    }
    const commands = workflow.split("\n").filter((line) =>
      /^\s+run: .*?(?:check:api-typecheck|check-api-typecheck-rebuilds-db\.mjs)/.test(line),
    );
    assert.equal(commands.length, name === "frontend-typecheck-refresh" ? 5 : 9);
    const filenames = commands.map((command) => {
      const match = command.match(/ --failure-report "\$\{\{ env\.API_TYPECHECK_FAILURE_REPORT_DIR \}\}\/([a-z0-9-]+\.json)"$/);
      assert.ok(match, command);
      assert.equal(command.match(/--failure-report/g).length, 1);
      return match[1];
    });
    assert.equal(new Set(filenames).size, commands.length);
    const upload = workflow.split("      - name: Upload API typecheck failure reports\n")[1]?.split(/\n      - |\n  \S/)[0];
    assert.ok(upload);
    for (const expected of [
      "if: ${{ always() }}", "continue-on-error: true",
      "uses: actions/upload-artifact@v4",
      "path: ${{ env.API_TYPECHECK_FAILURE_REPORT_DIR }}/*.json",
      "if-no-files-found: ignore", "retention-days: 14",
    ]) assert.ok(upload.includes(expected), expected);
    const artifact = upload.match(/name: (.+)/)?.[1];
    assert.equal(artifact, directory.split("/").at(-1).replace(/^(frontend|native)-/, "api-typecheck-failures-$1-"));
  });
}

test("native coverage accepts report suffixes but not extra commands or probe flags", async () => {
  const workflow = await readWorkflow("native-process-identity");
  assert.doesNotThrow(() => checkNativeProcessWorkflowCoverage({ workflow }));
  for (const suffix of [" --unexpected", " && echo masked"]) {
    const altered = workflow.replace('/native.json"', `/native.json"${suffix}`);
    assert.throws(() => checkNativeProcessWorkflowCoverage({ workflow: altered }), /must retain required native probe steps/);
  }
});

test("failure report tests run after Node setup in both supported runtime matrices", async () => {
  for (const [name, job] of [
    ["frontend-typecheck-refresh", "standard-recovery"],
    ["native-process-identity", "process-identity"],
  ]) {
    const workflow = await readWorkflow(name);
    const body = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
    assert.ok(body, job);
    const steps = body.split(/\n      - /);
    const index = steps.findIndex((step) => step.includes(
      "run: node --test scripts/api-typecheck-failure-report.test.mjs scripts/api-typecheck-failure-report-workflows.test.mjs"));
    assert.ok(index > 0, `${name} must run the publication suite`);
    assert.doesNotMatch(steps[index], /\n\s+(?:if|continue-on-error):/);
    assert.ok(steps.slice(0, index).some((step) =>
      step.includes("uses: actions/setup-node@v4") &&
      step.includes("node-version: ${{ matrix.node }}")));
    if (name === "frontend-typecheck-refresh") {
      assert.match(body, /runs-on: ubuntu-latest/);
      assert.match(body, /node: \[22, 24\]/);
    } else {
      // The existing contract checks every Windows/macOS Node 22/24 row.
      assert.doesNotThrow(() => checkNativeProcessWorkflowCoverage({ workflow }));
    }
  }
});
