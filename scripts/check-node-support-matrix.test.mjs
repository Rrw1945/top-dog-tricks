import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./api-typecheck-failure-report-workflows.test.mjs";
import { fileURLToPath } from "node:url";
import { matchesPathPattern } from "./glob-patterns.mjs";

import {
  checkNativeProcessDiagnosticsCollectorContract,
  checkNativeProcessProbeContract,
  checkNativeProcessWorkflowCoverage,
  checkNativeProcessWorkflowContract,
  checkNativeProcessWorkflowStepOrder,
  checkRecoveryRegressionCommandCoverage,
  checkStandardRecoveryCommandContract,
  checkNodeSupportMatrix,
  checkNodeVersionFileTriggerCoverage,
  checkNodeCompatibilityGuardCoverage,
  checkLocalReusableNodeGuardCoverage,
  loadNodeVersionFiles,
  loadNodeVersionFileInputs,
  loadWorkflowFiles,
  nativeProcessDiagnosticArtifactNames,
  requiredNativeProcessMatrixEntries,
  requiredNativeProcessProbePhases,
  supportedNodeMajors,
  workflowNodeMajors,
} from "./check-node-support-matrix.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function reusableCaller(target = "node.yml", guard = "") {
  return `on: workflow_call
jobs:
  delegate:
    ${guard}
    uses: ./.github/workflows/${target}
`;
}

test("local reusable Node calls reject unsafe caller guards with caller context", () => {
  for (const guard of ["if: false", "if: needs.paths.outputs.changed == 'true'", "if: github.event_name == 'workflow_dispatch'"]) {
    assert.throws(() => checkLocalReusableNodeGuardCoverage({ workflows: {
      "caller.yml": reusableCaller("node.yml", guard),
      "node.yml": guardedNodeWorkflow(),
    } }), /caller\.yml job "delegate" calling .*node\.yml: caller if guard may skip delegated Node/);
  }
});

test("local reusable Node calls accept safe guards and quoted direct properties", () => {
  for (const guard of ["", "if: true", "if: ${{ always() && !cancelled() }}", "if: >-\n      success()"]) {
    checkLocalReusableNodeGuardCoverage({ workflows: {
      "caller.yml": reusableCaller("node.yaml", guard)
        .replace("uses:", "'uses':").replace("if:", '"if":'),
      "node.yaml": guardedNodeWorkflow(),
    } });
  }
});

test("local reusable Node calls follow nested workflows and report each unsafe caller", () => {
  assert.throws(() => checkLocalReusableNodeGuardCoverage({ workflows: {
    "caller.yml": reusableCaller("middle.yml", "if: false"),
    "middle.yml": reusableCaller("node.yml", "if: false"),
    "node.yml": guardedNodeWorkflow(),
  } }), (error) => {
    assert.match(error.message, /caller\.yml job "delegate".*caller if guard/);
    assert.match(error.message, /middle\.yml job "delegate".*caller if guard/);
    return true;
  });
});

test("unrelated reusable jobs, remote calls, nested uses and shell text are not Node callers", () => {
  checkLocalReusableNodeGuardCoverage({ workflows: {
    "caller.yml": reusableCaller("unrelated.yml", "if: false"),
    "unrelated.yml": `jobs:
  unrelated:
    if: false
    runs-on: ubuntu-latest
    env:
      uses: ./.github/workflows/node.yml
    steps:
      - run: |
          uses: actions/setup-node@v4
  remote:
    if: false
    uses: owner/repo/.github/workflows/node.yml@main
`,
    "node.yml": guardedNodeWorkflow(),
  } });
});

test("local reusable references fail closed without resolving external or parent paths", () => {
  for (const target of ["missing.yml", "../node.yml", "nested/node.yml", "node.yml@main", "${{ inputs.workflow }}"]) {
    assert.throws(() => checkLocalReusableNodeGuardCoverage({ workflows: {
      "caller.yml": reusableCaller(target),
      "node.yml": guardedNodeWorkflow(),
    } }), /caller\.yml job "delegate".*(missing local workflow|unsupported repository-local workflow reference)/);
  }
});

test("local reusable traversal detects self and indirect cycles even alongside Node setup", () => {
  for (const target of ["caller.yml", "middle.yml"]) {
    assert.throws(() => checkLocalReusableNodeGuardCoverage({ workflows: {
      "caller.yml": reusableCaller(target),
      "middle.yml": reusableCaller("caller.yml") + `  runtime:
    steps:
      - uses: actions/setup-node@v4
`,
    } }), /caller\.yml job "delegate".*local workflow cycle:/);
  }
});

test("local reusable traversal accepts shared descendants without treating them as cycles", () => {
  checkLocalReusableNodeGuardCoverage({ workflows: {
    "caller.yml": reusableCaller("middle.yml") + `  other:
    uses: ./.github/workflows/node.yml
`,
    "middle.yml": reusableCaller("node.yml"),
    "node.yml": guardedNodeWorkflow(),
  } });
});

test("local reusable traversal bounds deep and wide graphs", () => {
  const deep = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
    `depth-${index}.yml`,
    index === 32 ? guardedNodeWorkflow() : reusableCaller(`depth-${index + 1}.yml`),
  ]));
  assert.throws(() => checkLocalReusableNodeGuardCoverage({ workflows: deep }), /exceeds 32 levels/);
  delete deep["depth-32.yml"];
  deep["depth-31.yml"] = guardedNodeWorkflow();
  checkLocalReusableNodeGuardCoverage({ workflows: deep });

  const wide = { "caller.yml": reusableCaller("wide.yml"), "wide.yml": "jobs:\n" };
  for (let index = 0; index < 512; index++) {
    wide["wide.yml"] += `  call-${index}:\n    uses: ./.github/workflows/leaf-${index}.yml\n`;
    wide[`leaf-${index}.yml`] = guardedNodeWorkflow();
  }
  assert.throws(() => checkLocalReusableNodeGuardCoverage({ workflows: wide }), /exceeds 512 workflows/);
});

test("checked-in local reusable jobs preserve delegated Node coverage", async () => {
  checkLocalReusableNodeGuardCoverage({ workflows: await loadWorkflowFiles() });
});

test("shared reusable descendants cannot hide an over-depth path through memoization", () => {
  const workflows = {
    "caller.yml": reusableCaller("branch.yml"),
    "branch.yml": reusableCaller("tail.yml") + `  longer:
    uses: ./.github/workflows/depth-0.yml
`,
    "tail.yml": reusableCaller("node.yml"),
    "node.yml": guardedNodeWorkflow(),
  };
  for (let index = 0; index < 29; index++) {
    workflows[`depth-${index}.yml`] = reusableCaller(
      index === 28 ? "tail.yml" : `depth-${index + 1}.yml`,
    );
  }
  assert.throws(() => checkLocalReusableNodeGuardCoverage({ workflows }),
    /caller\.yml job "delegate".*exceeds 32 levels/);
});

function guardedNodeWorkflow({ jobGuard = "", stepGuard = "" } = {}) {
  return `on: [push, pull_request]
jobs:
  compatibility:
    ${jobGuard}
    runs-on: ubuntu-latest
    steps:
      - id: runtime
        name: Set up Node
        ${stepGuard}
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - name: Failure diagnostics
        if: failure()
        run: echo diagnostics
  unrelated:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - run: echo unrelated
`;
}

for (const guard of [
  "", "if: true", "if: success()", "if: ${{ always() }}",
  'if: "${{ !cancelled() }}"',
  "if: (true)",
  "if: ${{ ((success())) }}",
  "if: ${{ success() && !cancelled() }}",
  "if: ${{ (always() || success()) && (!cancelled() || true) }}",
  "if: ${{ true || success() && always() }}",
  "if: ${{ (TRUE&&SUCCESS ( ))||! CANCELLED( ) }}",
  'if: "${{ (success() && true) || always() }}"',
  "if: '${{ (success() || always()) && !cancelled() }}'",
]) {
  test(`Node guard coverage accepts safe guard ${guard || "(absent)"} and unrelated conditions`, () => {
    checkNodeCompatibilityGuardCoverage({
      workflows: { "runtime.yml": guardedNodeWorkflow({ jobGuard: guard, stepGuard: guard }) },
    });
  });
}

for (const guard of [
  "if: false",
  "if: needs.changes.outputs.source == 'true'",
  "if: github.event_name == 'schedule'",
  "if: ${{ success() && contains(github.event.head_commit.message, 'source') }}",
  "if: >-\n      ${{ needs.changes.outputs.source == 'true' }}",
  "if: ${{ (success() && needs.changes.outputs.source == 'true') }}",
  "if: ${{ (always() && github.event_name == 'push') }}",
  "if: ${{ true || github.event_name == 'schedule' }}",
  "if: ${{ needs.changes.outputs.source == 'true' || true }}",
  "if: ${{ true || (success() && false) }}",
  "if: ${{ (failure() || cancelled()) }}",
  "if: ${{ !(success()) }}",
  "if: ${{ !!cancelled() }}",
  "if: ${{ success('true') }}",
  "if: ${{ 'true' }}",
  "if: ${{ true == true }}",
  "if: ${{ trueValue }}",
  "if: ${{ true || process.exit() }}",
  "if: ${{ }}",
  "if: ${{ () }}",
  "if: ${{ (true }}",
  "if: ${{ true) }}",
  "if: ${{ true && }}",
  "if: ${{ || true }}",
  "if: ${{ true || || success() }}",
  "if: ${{ true success() }}",
  "if: ${{ true & success() }}",
  "if: ${{ true }} || ${{ true }}",
  "if: ${{ (true) }} trailing",
]) {
  test(`Node job guard coverage rejects ${guard}`, () => {
    assert.throws(() => checkNodeCompatibilityGuardCoverage({
      workflows: { "runtime.yml": guardedNodeWorkflow({ jobGuard: guard }) },
    }), /runtime\.yml job "compatibility": job if guard may skip/);
  });
  test(`Node setup guard coverage rejects ${guard}`, () => {
    assert.throws(() => checkNodeCompatibilityGuardCoverage({
      workflows: { "runtime.yml": guardedNodeWorkflow({
        stepGuard: guard.replace("\n      ", "\n          "),
      }) },
    }), /runtime\.yml job "compatibility" step "runtime": setup if guard may skip/);
  });
}

test("Node guard coverage handles if-first steps and ignores nested if keys", () => {
  const workflow = guardedNodeWorkflow()
    .replace("- id: runtime", "- if: false\n        id: runtime");
  assert.throws(() => checkNodeCompatibilityGuardCoverage({
    workflows: { "runtime.yml": workflow },
  }), /step "runtime": setup if guard/);
  checkNodeCompatibilityGuardCoverage({
    workflows: { "runtime.yml": guardedNodeWorkflow()
      .replace("node-version-file: .nvmrc", "node-version-file: .nvmrc\n          if: false") },
  });
});

test("checked-in Node jobs have version-change-safe execution guards", async () => {
  checkNodeCompatibilityGuardCoverage({ workflows: await loadWorkflowFiles() });
});

test("Node guard coverage accepts multiline safe guards", () => {
  checkNodeCompatibilityGuardCoverage({
    workflows: { "runtime.yml": guardedNodeWorkflow({
      jobGuard: "if: >-\n      ${{ (always() ||\n          success()) && true }}",
      stepGuard: "if: |\n          ${{ !cancelled() &&\n              (true || success()) }}",
    }) },
  });
});

for (const scope of ["jobGuard", "stepGuard"]) {
  test(`Node guard parser bounds ${scope} input size, token count, and nesting`, () => {
    const check = (expression) => checkNodeCompatibilityGuardCoverage({
      workflows: { "runtime.yml": guardedNodeWorkflow({ [scope]: `if: ${expression}` }) },
    });
    assert.doesNotThrow(() => check("(".repeat(32) + "true" + ")".repeat(32)));
    assert.throws(() => check("(".repeat(33) + "true" + ")".repeat(33)), /if guard may skip/);
    assert.doesNotThrow(() => check(Array(256).fill("true").join("||")));
    assert.throws(() => check(Array(257).fill("true").join("||")), /if guard may skip/);
    assert.doesNotThrow(() => check(`true${" ".repeat(4086)}||true`));
    assert.throws(() => check(`true${" ".repeat(4087)}||true`), /if guard may skip/);
  });
}

for (const quote of ["'", '"']) {
  for (const scope of ["jobGuard", "stepGuard"]) {
    test(`Node guard coverage rejects ${scope} with ${quote}-quoted mapping keys`, () => {
      const workflow = guardedNodeWorkflow({ [scope]: "if: false" })
        .replace(/^(\s*(?:- )?)(jobs|compatibility|unrelated|steps|uses|if|id|name):/gm,
          (_, prefix, key) => `${prefix}${quote}${key}${quote}:`);
      assert.throws(() => checkNodeCompatibilityGuardCoverage({
        workflows: { "runtime.yml": workflow },
      }), scope === "jobGuard"
        ? /runtime\.yml job "compatibility": job if guard/
        : /runtime\.yml job "compatibility" step "runtime": setup if guard/);
    });
  }
  test(`Node guard coverage detects ${quote}-quoted uses-first setup steps`, () => {
    const workflow = guardedNodeWorkflow({ jobGuard: "if: false", stepGuard: "if: false" })
      .replace("- id: runtime\n        name: Set up Node", `- ${quote}uses${quote}: actions/setup-node@v4`)
      .replace("        uses: actions/setup-node@v4\n", "");
    assert.throws(() => checkNodeCompatibilityGuardCoverage({
      workflows: { "runtime.yml": workflow },
    }), (error) => {
      assert.match(error.message, /job "compatibility": job if guard/);
      assert.match(error.message, /step "#1 \(actions\/setup-node\)": setup if guard/);
      return true;
    });
  });
}

test("Node guard coverage reports both job and unnamed setup guards for explicit versions", () => {
  const workflow = guardedNodeWorkflow({ jobGuard: "if: false", stepGuard: "if: false" })
    .replace("- id: runtime\n        name: Set up Node", "- uses: actions/setup-node@v4")
    .replace("        uses: actions/setup-node@v4\n", "")
    .replace("node-version-file: .nvmrc", "node-version: 24");
  assert.throws(() => checkNodeCompatibilityGuardCoverage({
    workflows: { "runtime.yml": workflow },
  }), (error) => {
    assert.match(error.message, /job "compatibility": job if guard/);
    assert.match(error.message, /step "#1 \(actions\/setup-node\)": setup if guard/);
    assert.doesNotMatch(error.message, /unrelated/);
    return true;
  });
});

test("each standard recovery fixture runs unless cancelled and retains failures on every supported Node major", async () => {
  const workflow = await readFile(
    path.join(workspaceRoot, ".github/workflows/frontend-typecheck-refresh.yml"),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  );
  const job = workflow.split("\n  standard-recovery:\n")[1]?.split(/\n  [\w-]+:\n/)[0];
  assert.ok(job, "CI must retain the dedicated standard recovery job");
  assert.deepEqual(workflowNodeMajors(job), supportedNodeMajors(packageJson.engines.node));
  assert.match(job, /name: Standard recovery on Node\.js \$\{\{ matrix\.node \}\}/);
  assert.match(job, /fail-fast: false/);
  assert.match(job, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(job, /run: pnpm install --frozen-lockfile/);
  const { scripts } = checkStandardRecoveryCommandContract({ packageJson });
  const fixtures = job.split(/^\s{6}- /m).filter(
    (step) => /run: pnpm run check:api-typecheck-rebuilds-libs:/.test(step),
  );
  assert.equal(fixtures.length, scripts.length, "each fixture needs its own CI step");
  const jobTimeout = Number(job.match(/^    timeout-minutes: (\d+)\s*$/m)?.[1]);
  assert.equal(jobTimeout, 15, "retain the overall recovery job time limit");
  const fixtureTimeouts = fixtures.map((step) =>
    Number(step.match(/^        timeout-minutes: (\d+)\s*$/m)?.[1]),
  );
  assert.deepEqual(fixtureTimeouts, [5, 2, 2, 2, 2],
    "bound each named fixture, allowing extra time for interruption's repeated builds");
  assert.ok(fixtureTimeouts.reduce((sum, minutes) => sum + minutes, 0) < jobTimeout,
    "fixture timeouts must leave setup headroom within the overall job limit");
  assert.deepEqual(
    fixtures.map((step) => step.match(/^\s*run: pnpm run (\S+) --failure-report "\$\{\{ env\.API_TYPECHECK_FAILURE_REPORT_DIR \}\}\/[a-z0-9-]+\.json"\s*$/m)?.[1]),
    scripts,
    "run every recovery fixture independently, without shell failure suppression",
  );
  for (const step of fixtures) {
    assert.doesNotMatch(step, /^\s*continue-on-error:/m,
      "fixture failures must remain job failures");
    assert.match(step, /^name: .+Node\.js \$\{\{ matrix\.node \}\}/);
    assert.match(step, /^\s*if: \$\{\{ !cancelled\(\) \}\}\s*$/m,
      "prior failures must not skip fixtures, but cancellation must");
  }
});
const recoveryDiagnosticsVerifierPath = path.join(
  workspaceRoot,
  "scripts",
  "check-api-typecheck-rebuilds-db.mjs",
);
const recoveryDiagnosticsValidationCommand =
  "pnpm exec node ./scripts/check-api-typecheck-rebuilds-db.mjs --verify-native-process-recovery-diagnostics";
const nativeProcessMatrixYaml = requiredNativeProcessMatrixEntries
  .map(
    ({ host, os, node }) =>
      `          - host: ${host}\n            os: ${os}\n            node: ${node}`,
  )
  .join("\n");
const representativeNativeProcessMatrixEntries = Object.freeze([
  ...requiredNativeProcessMatrixEntries,
  Object.freeze({ host: "Linux", os: "ubuntu-latest", node: 22 }),
  Object.freeze({ host: "macOS", os: "macos-latest", node: 26 }),
]);

const validNativeProcessWorkflow = `
name: Native process identity probes

on:
  pull_request:
    paths:
      - package.json
  push:
    branches:
      - main
  schedule:
    - cron: "17 4 * * 1"
  workflow_dispatch:

jobs:
  process-identity:
    runs-on: ubuntu-latest
`;

const validAlternateNativeProcessWorkflow = `
name: Native process identity probes

'on':
  'pull_request':
  'push':
    'branches': ['main']
  'schedule': [{ 'cron': '17 4 * * 1' }]
  'workflow_dispatch':

jobs:
  process-identity:
    runs-on: ubuntu-latest
`;

const validCompactNativeProcessWorkflow = `
name: Native process identity probes

'on': { 'pull_request': {}, 'push': { 'branches': ['main'] }, 'schedule': [{ 'cron': '17 4 * * 1' }], 'workflow_dispatch': {} }

jobs:
  process-identity:
    runs-on: ubuntu-latest
`;

const validNativeProcessWorkflowCoverage = `
on:
  pull_request:
    paths:
      - "artifacts/api-server/src/lib/httpShutdown.ts"
      - "artifacts/api-server/src/lib/httpShutdown.test.ts"
      - "scripts/check-native-transition-interruption.test.mjs"
  push:
    paths:
      - "artifacts/api-server/src/lib/httpShutdown.ts"
      - "artifacts/api-server/src/lib/httpShutdown.test.ts"
      - "scripts/check-native-transition-interruption.test.mjs"
jobs:
  process-identity:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        include:
${nativeProcessMatrixYaml}
    steps:
      - name: Run Node support matrix regression tests
        id: node-support-matrix-tests
        run: pnpm run test:node-support-matrix
      - name: Verify Node support matches the CI matrix
        id: node-support-matrix-contract
        run: pnpm run check:node-support-matrix
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - name: Verify HTTP shutdown socket count
        env:
          API_TEST_FILE: src/lib/httpShutdown.test.ts
        run: pnpm --filter @workspace/api-server test
      - name: Verify interrupted owner cleanup
        run: node --test scripts/check-native-transition-interruption.test.mjs
      - name: Verify stale lock takeover
        id: native-process-identity
        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native
      - name: Verify transition-lock owner exit recovery
        id: native-process-identity-transition-exit
        env:
          API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS: "3"
        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-transition-exit
      - name: Verify frozen probe timeout
        id: native-process-identity-timeout
        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-timeout
      - name: Verify frozen probe descendant cleanup
        id: native-process-identity-descendant-lifecycle
        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-descendant-lifecycle
      - name: Verify PID-reuse recovery batch safety
        id: native-process-identity-recovery
        env:
          API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE: \${{ runner.temp }}/native-process-diagnostics/pid-reuse-recovery-batch.json
        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:recovery
      - name: Validate scheduled PID-reuse recovery record
        if: \${{ github.event_name == 'schedule' && steps.native-process-identity-recovery.outcome == 'success' }}
        id: native-process-identity-recovery-record
        env:
          API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE: \${{ runner.temp }}/native-process-diagnostics/pid-reuse-recovery-batch.json
        run: ${recoveryDiagnosticsValidationCommand}
      - name: Verify Windows interrupted publication recovery
        if: \${{ matrix.os == 'windows-latest' }}
        id: interrupted-publication-recovery
        env:
          API_TYPECHECK_INTERRUPTED_PUBLICATION_RUNS: "3"
          API_TYPECHECK_INTERRUPTED_PUBLICATION_CRASH_POINTS: "staging,active,restore"
        run: pnpm run check:api-typecheck-rebuilds-libs:interrupted-publication
      - name: Record failed native probe before diagnostics collection
        if: \${{ failure() && github.event_name == 'schedule' }}
        continue-on-error: true
        env:
          API_TYPECHECK_NATIVE_PROBE_FAILURE: >-
            \${{ steps.node-support-matrix-tests.outcome == 'failure' && 'node-support-matrix-tests' ||
                steps.node-support-matrix-contract.outcome == 'failure' && 'node-support-matrix-contract' ||
                steps.native-process-identity.outcome == 'failure' && 'stale-lock-takeover' ||
                steps.native-process-identity-transition-exit.outcome == 'failure' && 'transition-lock-owner-exit' ||
                steps.native-process-identity-timeout.outcome == 'failure' && 'frozen-probe-timeout' ||
                steps.native-process-identity-descendant-lifecycle.outcome == 'failure' && 'frozen-probe-descendant-cleanup' ||
                steps.native-process-identity-recovery.outcome == 'failure' && 'pid-reuse-recovery-batch' ||
                steps.native-process-identity-recovery-record.outcome == 'failure' && 'pid-reuse-recovery-record-validation' ||
                steps.interrupted-publication-recovery.outcome == 'failure' && 'windows-interrupted-publication' ||
                'unknown' }}
          API_TYPECHECK_NATIVE_PROBE_PHASE: >-
            \${{ steps.native-process-identity.outcome == 'failure' &&
                steps.native-process-identity.outputs.phase ||
                'not-applicable' }}
        run: pnpm exec node ./scripts/check-api-typecheck-rebuilds-db.mjs --record-native-process-probe-failure
      - name: Collect hosted-runner diagnostics after scheduled failure
        if: \${{ failure() && github.event_name == 'schedule' }}
        continue-on-error: true
        env:
          API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR: \${{ runner.temp }}/native-process-diagnostics
        run: pnpm exec node ./scripts/check-api-typecheck-rebuilds-db.mjs --collect-native-process-diagnostics
      - name: Upload hosted-runner diagnostics
        if: \${{ failure() && github.event_name == 'schedule' }}
        uses: actions/upload-artifact@v4
        with:
          name: native-process-diagnostics-\${{ matrix.os }}-node-\${{ matrix.node }}
          path: \${{ runner.temp }}/native-process-diagnostics
          if-no-files-found: ignore
          retention-days: 14
      - name: Upload successful weekly recovery record
        id: native-process-identity-recovery-upload
        if: \${{ success() && github.event_name == 'schedule' && steps.native-process-identity-recovery-record.outcome == 'success' }}
        uses: actions/upload-artifact@v4
        with:
          name: native-process-recovery-record-\${{ matrix.os }}-node-\${{ matrix.node }}
          path: \${{ runner.temp }}/native-process-diagnostics/pid-reuse-recovery-batch.json
          if-no-files-found: error
          retention-days: 28
`;

test("retains only validated successful weekly records separately from failure bundles", () => {
  assert.doesNotThrow(() => checkNativeProcessWorkflowCoverage({
    workflow: validNativeProcessWorkflowCoverage,
  }));
  const successStep = validNativeProcessWorkflowCoverage.match(
    /      - name: Upload successful weekly recovery record[\s\S]*?retention-days: 28\n/,
  )[0];
  const mutations = [
    ["missing upload", "", /exactly one successful weekly/],
    ["duplicate upload", successStep + successStep, /exactly one successful weekly/],
    ["non-scheduled", successStep.replace("github.event_name == 'schedule'", "true"), /require scheduled success/],
    ["failed row", successStep.replace("success()", "always()"), /require scheduled success/],
    ["unvalidated", successStep.replace("steps.native-process-identity-recovery-record.outcome == 'success'", "true"), /require scheduled success/],
    ["bundle path", successStep.replace("/pid-reuse-recovery-batch.json", ""), /only the validated PID-reuse JSON/],
    ["missing file ignored", successStep.replace("if-no-files-found: error", "if-no-files-found: ignore"), /fail when its JSON is missing/],
    ...["", "0", "fourteen", "14"].map((value) => [
      `retention ${value}`, successStep.replace("retention-days: 28", value ? `retention-days: ${value}` : ""), /retain records for 28 days/,
    ]),
    ["host collision", successStep.replace("${{ matrix.os }}", "host"), /distinct from failure bundles and unique/],
    ["Node collision", successStep.replace("${{ matrix.node }}", "node"), /distinct from failure bundles and unique/],
    ["failure bundle name", successStep.replace("name: native-process-recovery-record-", "name: native-process-diagnostics-"), /distinct from failure bundles and unique/],
    ["wrong action", successStep.replace("upload-artifact@v4", "download-artifact@v4"), /must use actions\/upload-artifact/],
  ];
  for (const [label, replacement, message] of mutations) {
    assert.throws(() => checkNativeProcessWorkflowCoverage({
      workflow: validNativeProcessWorkflowCoverage.replace(successStep, replacement),
    }), message, label);
  }
  assert.throws(() => checkNativeProcessWorkflowCoverage({
    workflow: validNativeProcessWorkflowCoverage.replace(successStep, "").replace(
      "      - name: Validate scheduled PID-reuse recovery record",
      successStep + "      - name: Validate scheduled PID-reuse recovery record",
    ),
  }), /after validation and all native probes/);
});

test("requires interrupted owner cleanup on every native row after Node setup", async (t) => {
  const step = `      - name: Verify interrupted owner cleanup
        run: node --test scripts/check-native-transition-interruption.test.mjs
`;
  const base = validNativeProcessWorkflowCoverage;
  assert.ok(base.includes(step));
  assert.doesNotThrow(() => checkNativeProcessWorkflowCoverage({ workflow: base }));
  for (const [label, workflow] of [
    ["removed", base.replace(step, "")],
    ["wrong command", base.replace(step, step.replace("node --test", "echo"))],
    ["skipped", base.replace(step, step.replace("        run:", "        if: false\n        run:"))],
    ["Windows only", base.replace(step, step.replace("        run:", "        if: ${{ matrix.os == 'windows-latest' }}\n        run:"))],
    ["non-blocking step", base.replace(step, step.replace("        run:", "        continue-on-error: true\n        run:"))],
    ["skipped job", base.replace("  process-identity:\n", "  process-identity:\n    if: false\n")],
    ["non-blocking job", base.replace("  process-identity:\n", "  process-identity:\n    continue-on-error: true\n")],
    ["skipped setup", base.replace("      - uses: actions/setup-node@v4\n", "      - uses: actions/setup-node@v4\n        if: false\n")],
    ["non-blocking setup", base.replace("      - uses: actions/setup-node@v4\n", "      - uses: actions/setup-node@v4\n        continue-on-error: true\n")],
    ["before setup", base.replace(step, "").replace("      - uses: actions/setup-node@v4", step + "      - uses: actions/setup-node@v4")],
    ["wrong runtime", base.replace("node-version: ${{ matrix.node }}", "node-version: 22")],
    ["wrong runner", base.replace("runs-on: ${{ matrix.os }}", "runs-on: ubuntu-latest")],
    ["unrelated job", base.replace(step, "") + `  unrelated:\n    runs-on: ubuntu-latest\n    steps:\n${step}`],
  ]) {
    await t.test(label, () => {
      assert.throws(() => checkNativeProcessWorkflowCoverage({ workflow }),
        /must run interrupted owner cleanup/);
    });
  }
  for (const { host, os, node } of requiredNativeProcessMatrixEntries) {
    await t.test(`missing ${host} Node ${node}`, () => {
      const row = `          - host: ${host}\n            os: ${os}\n            node: ${node}`;
      assert.ok(base.includes(row));
      assert.throws(() => checkNativeProcessWorkflowCoverage({ workflow: base.replace(row, "") }),
        /must run interrupted owner cleanup/);
    });
  }
});

test("requires interruption test changes to trigger both native CI events", async (t) => {
  const source = "scripts/check-native-transition-interruption.test.mjs";
  for (const trigger of ["pull_request", "push"]) {
    await t.test(trigger, () => {
      const start = validNativeProcessWorkflowCoverage.indexOf(`  ${trigger}:\n`);
      const before = validNativeProcessWorkflowCoverage.slice(0, start);
      const after = validNativeProcessWorkflowCoverage.slice(start);
      for (const replacement of ["", `      - "!${source}"\n`]) {
        assert.throws(() => checkNativeProcessWorkflowCoverage({
          workflow: before + after.replace(`      - "${source}"\n`, replacement),
        }), (error) => error.message.includes(`${trigger} must trigger interrupted owner cleanup coverage for "${source}"`));
      }
      assert.throws(() => checkNativeProcessWorkflowCoverage({
        workflow: before + after.replace("    paths:\n", `    paths-ignore:\n      - "${source}"\n    paths:\n`),
      }), /must trigger interrupted owner cleanup coverage/);
    });
  }
  assert.doesNotThrow(() => checkNativeProcessWorkflowCoverage({
    workflow: validNativeProcessWorkflowCoverage.replaceAll(`      - "${source}"`, '      - "scripts/**"'),
  }));
});

test("requires focused HTTP shutdown coverage on every supported native runner", async (t) => {
  const step = `      - name: Verify HTTP shutdown socket count
        env:
          API_TEST_FILE: src/lib/httpShutdown.test.ts
        run: pnpm --filter @workspace/api-server test
`;
  for (const [label, replacement] of [
    ["removed", ""],
    ["wrong test file", step.replace("src/lib/httpShutdown.test.ts", "src/lib/other.test.ts")],
    ["unfocused", step.replace("          API_TEST_FILE: src/lib/httpShutdown.test.ts\n", "")],
    ["wrong command", step.replace("@workspace/api-server test", "@workspace/api-server build")],
    ["Windows only", step.replace("        env:", "        if: ${{ matrix.os == 'windows-latest' }}\n        env:")],
    ["tolerated failures", step.replace("        env:", "        continue-on-error: true\n        env:")],
  ]) {
    await t.test(label, () => {
      assert.throws(() => checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(step, replacement),
      }), /must run the focused HTTP shutdown test/);
    });
  }
  await t.test("a separate non-matrix job cannot supply the coverage", () => {
    assert.throws(() => checkNativeProcessWorkflowCoverage({
      workflow: validNativeProcessWorkflowCoverage.replace(step, "") +
        `  unrelated:\n    runs-on: ubuntu-latest\n    steps:\n${step}`,
    }), /must run the focused HTTP shutdown test/);
  });
  await t.test("the matrix job cannot silently switch to one runner", () => {
    assert.throws(() => checkNativeProcessWorkflowCoverage({
      workflow: validNativeProcessWorkflowCoverage.replace(
        "runs-on: ${{ matrix.os }}", "runs-on: ubuntu-latest",
      ),
    }), /must run the focused HTTP shutdown test/);
  });
  await t.test("the focused test must run after matrix Node setup", () => {
    assert.throws(() => checkNativeProcessWorkflowCoverage({
      workflow: validNativeProcessWorkflowCoverage.replace(step, "").replace(
        "      - uses: actions/setup-node@v4", step + "      - uses: actions/setup-node@v4",
      ),
    }), /must run the focused HTTP shutdown test/);
  });
  const workflow = await readFile(path.join(workspaceRoot, ".github/workflows/native-process-identity.yml"), "utf8");
  assert.doesNotThrow(() => checkNativeProcessWorkflowCoverage({ workflow }));
});

test("requires both shutdown source files to trigger pull requests and pushes", async (t) => {
  for (const trigger of ["pull_request", "push"]) {
    for (const file of ["httpShutdown.ts", "httpShutdown.test.ts"]) {
      await t.test(`${trigger}: ${file}`, () => {
        const header = `  ${trigger}:\n    paths:\n`;
        const start = validNativeProcessWorkflowCoverage.indexOf(header);
        const before = validNativeProcessWorkflowCoverage.slice(0, start);
        const after = validNativeProcessWorkflowCoverage.slice(start);
        const source = `artifacts/api-server/src/lib/${file}`;
        for (const replacement of ["", `      - "!${source}"\n`]) {
          const workflow = before + after.replace(`      - "${source}"\n`, replacement);
          assert.throws(() => checkNativeProcessWorkflowCoverage({ workflow }),
            (error) => error.message.includes(`${trigger} must trigger HTTP shutdown coverage for "${source}"`));
        }
      });
    }
  }
  assert.doesNotThrow(() => checkNativeProcessWorkflowCoverage({
    workflow: validNativeProcessWorkflowCoverage.replaceAll(
      '      - "artifacts/api-server/src/lib/httpShutdown.ts"\n      - "artifacts/api-server/src/lib/httpShutdown.test.ts"',
      '      - "artifacts/api-server/**"',
    ),
  }));
});

const validNativeProcessProbe = `
const nativeProcessProbePhases = new Set([
  "identity",
  "filesystem-setup",
  "transition-locking",
  "filesystem-cleanup",
]);

async function exposeNativeProcessProbePhase(phase) {
  if (!nativeProcessProbePhases.has(phase)) {
    throw new Error("Native process probe phase must be a recognized safe label");
  }
  const githubOutputFile = process.env.GITHUB_OUTPUT;
  if (githubOutputFile) {
    await writeFile(
      githubOutputFile,
      \`phase=\${phase}\\n\`,
      { flag: "a" },
    );
  }
}

if (testNativeProcessIdentity) {
  let phase = "identity";
  await exposeNativeProcessProbePhase(phase);
  phase = "filesystem-setup";
  await exposeNativeProcessProbePhase(phase);
  phase = "transition-locking";
  await exposeNativeProcessProbePhase(phase);
  phase = "filesystem-cleanup";
  await exposeNativeProcessProbePhase(phase);
}

if (testNativeTransitionLockOwnerExitProbe) {
`;

function runRecoveryDiagnosticsVerifier(diagnosticsPath) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        recoveryDiagnosticsVerifierPath,
        "--verify-native-process-recovery-diagnostics",
      ],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE: diagnosticsPath,
        },
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

const validMultiJobNativeProcessWorkflowCoverage = `${validNativeProcessWorkflowCoverage}
  recovery-probes:
    runs-on: ubuntu-latest
    steps:
      - name: Run Node support matrix regression tests for recovery probes
        id: recovery-node-support-matrix-tests
        run: pnpm run test:node-support-matrix
      - name: Verify Node support matches the CI matrix for recovery probes
        id: recovery-node-support-matrix-contract
        run: pnpm run check:node-support-matrix
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - name: Verify recovery probe
        id: recovery-probe
        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:recovery
`;

const validQuotedNativeProcessWorkflowCoverage =
  validNativeProcessWorkflowCoverage
    .replace(
      "  process-identity:\n",
      "  # Comments may surround a quoted native job ID.\n  'process-identity': # native job\n",
    )
    .concat(`  # This job does not run native checks and needs no compatibility gate.
  "metadata-only":
    runs-on: ubuntu-latest
    steps:
      - run: echo "unrelated"
`);

test("parses valid alternative ranges and removes duplicate majors", () => {
  assert.deepEqual(
    supportedNodeMajors(" ^22.0.0 || v24 || >=22.1.0 || ~24.2.0 "),
    [22, 24],
  );
});

test("accepts quoted native jobs alongside an unrelated job without the gate", () => {
  assert.doesNotThrow(() =>
    checkNativeProcessWorkflowStepOrder({
      workflow: validQuotedNativeProcessWorkflowCoverage,
    }),
  );
});

test("reports a double-quoted native job when its compatibility gate is missing", () => {
  const workflow = validQuotedNativeProcessWorkflowCoverage.replace(
    "  'process-identity': # native job\n",
    '  "process-identity": # native job\n',
  );
  assert.ok(workflow.includes('  "process-identity": # native job\n'));
  assert.doesNotThrow(() =>
    checkNativeProcessWorkflowStepOrder({ workflow }),
  );
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: workflow.replace(
          "      - name: Run Node support matrix regression tests\n        id: node-support-matrix-tests\n        run: pnpm run test:node-support-matrix\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes('job "process-identity"') &&
      error.message.includes("pnpm run test:node-support-matrix"),
  );
});

test("reports a quoted native job when its compatibility gate is missing", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validQuotedNativeProcessWorkflowCoverage.replace(
          "      - name: Run Node support matrix regression tests\n        id: node-support-matrix-tests\n        run: pnpm run test:node-support-matrix\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes('job "process-identity"') &&
      error.message.includes("pnpm run test:node-support-matrix"),
  );
});

test("requires a package command for every recovery regression flag", () => {
  assert.deepEqual(
    checkRecoveryRegressionCommandCoverage({
      apiTypecheckHarnessSource: `
        const testRecovery = process.argv.includes("--test-recovery");
        const testOtherRecovery = process.argv.includes(
          "--test-other-recovery",
        );
        const runFixture = process.argv.includes("--run-recovery-fixture");
      `,
      packageJson: {
        scripts: {
          recovery:
            "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-recovery",
          other:
            "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-other-recovery",
        },
      },
    }),
    { flags: ["--test-other-recovery", "--test-recovery"] },
  );
});

test("reports recovery regression flags missing from package commands", () => {
  assert.throws(
    () =>
      checkRecoveryRegressionCommandCoverage({
        apiTypecheckHarnessSource: `
          const testRecovery = process.argv.includes("--test-recovery");
          const testMissing = process.argv.includes("--test-missing");
        `,
        packageJson: {
          scripts: {
            recovery:
              "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-recovery",
          },
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Missing package.json command for --test-missing"),
  );
});

test("keeps the multi-rescan recovery regression command discoverable", async () => {
  const [packageJsonContents, apiTypecheckHarnessSource] = await Promise.all([
    readFile(path.join(workspaceRoot, "package.json"), "utf8"),
    readFile(recoveryDiagnosticsVerifierPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonContents);
  const { flags } = checkRecoveryRegressionCommandCoverage({
    packageJson,
    apiTypecheckHarnessSource,
  });

  assert.ok(flags.includes("--test-recovery-lock-multi-rescan-failure"));
  assert.equal(
    packageJson.scripts[
      "check:api-typecheck-rebuilds-libs:lock-multi-rescan-failure"
    ],
    "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-recovery-lock-multi-rescan-failure",
  );
});

test("requires every focused recovery fixture in the standard recovery command", () => {
  const focusedCommands = {
    "check:api-typecheck-rebuilds-libs:interruption":
      "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-interrupted-recovery",
    "check:api-typecheck-rebuilds-libs:lock-handoff":
      "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-recovery-lock-handoff",
    "check:api-typecheck-rebuilds-libs:lock-cleanup":
      "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-recovery-lock-cleanup",
    "check:api-typecheck-rebuilds-libs:lock-rescan-failure":
      "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-recovery-lock-rescan-failure",
    "check:api-typecheck-rebuilds-libs:lock-multi-rescan-failure":
      "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-recovery-lock-multi-rescan-failure",
  };
  const aggregateScript = "check:api-typecheck-rebuilds-libs:recovery";
  const packageJson = {
    scripts: {
      ...focusedCommands,
      [aggregateScript]: Object.keys(focusedCommands)
        .map((script) => `pnpm run ${script}`)
        .join(" && "),
    },
  };

  assert.deepEqual(
    checkStandardRecoveryCommandContract({ packageJson }),
    { scripts: Object.keys(focusedCommands) },
  );

  assert.throws(
    () =>
      checkStandardRecoveryCommandContract({
        packageJson: { scripts: focusedCommands },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(`${aggregateScript} must run`),
  );

  for (const script of Object.keys(focusedCommands)) {
    const withoutFixture = {
      scripts: {
        ...packageJson.scripts,
        [aggregateScript]: packageJson.scripts[aggregateScript]
          .split(" && ")
          .filter((command) => command !== `pnpm run ${script}`)
          .join(" && "),
      },
    };
    assert.throws(
      () => checkStandardRecoveryCommandContract({ packageJson: withoutFixture }),
      (error) =>
        error instanceof Error &&
        error.message.includes(`${aggregateScript} must run ${script}`),
    );

    const withoutFocusedCommand = {
      scripts: Object.fromEntries(
        Object.entries(packageJson.scripts).filter(
          ([scriptName]) => scriptName !== script,
        ),
      ),
    };
    assert.throws(
      () =>
        checkStandardRecoveryCommandContract({
          packageJson: withoutFocusedCommand,
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          `Missing independently runnable package command ${script}`,
        ),
    );
  }
});

test("repository standard recovery command retains every required fixture", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(checkStandardRecoveryCommandContract({ packageJson }), {
    scripts: [
      "check:api-typecheck-rebuilds-libs:interruption",
      "check:api-typecheck-rebuilds-libs:lock-handoff",
      "check:api-typecheck-rebuilds-libs:lock-cleanup",
      "check:api-typecheck-rebuilds-libs:lock-rescan-failure",
      "check:api-typecheck-rebuilds-libs:lock-multi-rescan-failure",
    ],
  });
});

test("rejects malformed or incomplete engines.node alternatives", () => {
  const malformedRanges = [
    "^22.0.0 ||",
    "^22.0.0 || latest",
    "^22.0.0 unexpected",
    "22.x || ^24.0.0",
    ">=22.0.0 <23.0.0",
  ];

  for (const nodeRange of malformedRanges) {
    assert.throws(
      () => supportedNodeMajors(nodeRange),
      (error) =>
        error instanceof Error &&
        error.message.includes("engines.node alternative"),
      `expected ${JSON.stringify(nodeRange)} to be rejected`,
    );
  }
});

test("deduplicates Node versions found in the workflow matrix", () => {
  assert.deepEqual(
    workflowNodeMajors(`
      matrix:
        include:
          - host: Linux
            node: 24
          - host: Windows
            node: "22.0"
          - host: macOS
            node: 24
    `),
    [22, 24],
  );
});

test("reads direct setup-node declarations", () => {
  assert.deepEqual(
    workflowNodeMajors(`
      - uses: actions/setup-node@v4
        with:
          node-version: 24
    `),
    [24],
  );
});

test("reads setup-node node-version-file declarations", () => {
  assert.deepEqual(
    workflowNodeMajors(
      `
        - uses: actions/setup-node@v4
          with:
            node-version-file: .nvmrc
      `,
      { nodeVersionFiles: { ".nvmrc": "v22.14.0\n" } },
    ),
    [22],
  );
});

for (const quote of ["", "'", '"']) {
  test(`discovers and validates ${quote || "unquoted"} node-version-file keys`, async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "quoted-node-key-"));
    try {
      const workflow = guardedNodeWorkflow().replace(
        "node-version-file: .nvmrc",
        `${quote}node-version-file${quote}: "./.nvmrc" # runtime`,
      );
      const workflows = { "quoted-runtime.yml": workflow };
      await writeFile(path.join(repositoryRoot, ".nvmrc"), "v22.14.0\n");
      const nodeVersionFiles = await loadNodeVersionFiles(workflows, { repositoryRoot });
      assert.deepEqual(Object.keys(nodeVersionFiles), [".nvmrc"]);
      assert.deepEqual(workflowNodeMajors(workflow, { nodeVersionFiles }), [22]);
      const check = (files = nodeVersionFiles, node = "^22.0.0") =>
        checkNodeSupportMatrix({
          packageJson: { engines: { node } },
          workflows,
          nodeVersionFiles: files,
        });
      assert.deepEqual(check(), {
        supported: [22],
        workflows: [{ workflow: "quoted-runtime.yml", matrix: [22], policy: "exact" }],
      });
      assert.throws(() => check(nodeVersionFiles, "^24.0.0"), /have drifted/);
      assert.deepEqual(checkNodeVersionFileTriggerCoverage({ workflows }), {
        workflows: ["quoted-runtime.yml"],
      });
      assert.throws(() => check({}), /node-version-file "\.nvmrc" could not be read/);
      for (const [contents, message] of [
        ["lts/*\n", /contains an unsupported Node version/],
        ["22.0.0\n24.0.0\n", /must contain exactly one explicit numeric Node version/],
        ["", /must contain exactly one explicit numeric Node version/],
      ]) {
        await writeFile(path.join(repositoryRoot, ".nvmrc"), contents);
        const files = await loadNodeVersionFiles(workflows, { repositoryRoot });
        assert.throws(() => check(files), message);
      }
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
}

test("accepts normalized relative node-version-file paths", () => {
  assert.deepEqual(
    workflowNodeMajors(
      `
        - uses: actions/setup-node@v4
          with:
            node-version-file: ./.nvmrc
      `,
      { nodeVersionFiles: { ".nvmrc": "v22.14.0\n" } },
    ),
    [22],
  );
});

test("reports direct version-file failures with stable file context", () => {
  const workflow = `
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
  `;

  assert.throws(
    () => workflowNodeMajors(workflow),
    (error) =>
      error instanceof Error &&
      error.message ===
        'node-version-file ".nvmrc" could not be read; use a checked-in file with an explicit numeric Node version',
  );

  const malformedVersion = "direct-malformed-version-content-must-not-leak";
  assert.throws(
    () =>
      workflowNodeMajors(workflow, {
        nodeVersionFiles: { ".nvmrc": malformedVersion },
      }),
    (error) =>
      error instanceof Error &&
      error.message ===
        'node-version-file ".nvmrc" contains an unsupported Node version; aliases are not supported because they cannot be compared to package.json engines.node' &&
      !error.message.includes(malformedVersion),
  );

  const incompleteVersionFile = "22.0.0\n24.0.0\n";
  assert.throws(
    () =>
      workflowNodeMajors(workflow, {
        nodeVersionFiles: { ".nvmrc": incompleteVersionFile },
      }),
    (error) =>
      error instanceof Error &&
      error.message ===
        'node-version-file ".nvmrc" must contain exactly one explicit numeric Node version' &&
      !error.message.includes("22.0.0") &&
      !error.message.includes("24.0.0"),
  );
});

for (const reference of ["package.json", "config/runtime/package.json"]) {
  test(`reports direct ${reference} version-file failures without exposing contents`, () => {
    const workflow = `
      - uses: actions/setup-node@v4
        with:
          node-version-file: ${reference}
    `;
    const packageContents = "private-package-details-must-not-leak";
    const unsupportedRange = "private-unsupported-node-range-must-not-leak";
    const expectedMessage =
      `node-version-file "${reference}" must contain a valid package.json with a supported engines.node range`;

    for (const contents of [
      JSON.stringify({ name: packageContents }),
      `{"name":"${packageContents}", invalid json`,
      JSON.stringify({
        name: packageContents,
        engines: { node: unsupportedRange },
      }),
    ]) {
      assert.throws(
        () =>
          workflowNodeMajors(workflow, {
            nodeVersionFiles: { [reference]: contents },
          }),
        (error) =>
          error instanceof Error &&
          error.message === expectedMessage &&
          error.message.includes(`node-version-file "${reference}"`) &&
          !error.message.includes(packageContents) &&
          !error.message.includes(unsupportedRange),
      );
    }
  });
}

test("rejects node-version-file paths that escape the repository", () => {
  const outsideContents = "outside-file-contents-must-not-be-read";
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0" } },
        workflows: {
          "unsafe-version-file-workflow.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version-file: ./../outside.nvmrc
          `,
        },
        nodeVersionFiles: { "../outside.nvmrc": outsideContents },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Workflow: .github/workflows/unsafe-version-file-workflow.yml",
      ) &&
      error.message.includes(
        'node-version-file "../outside.nvmrc" must reference a path within the repository',
      ) &&
      !error.message.includes(outsideContents),
  );
});

test("loads regular workflows and in-repository workflow symlinks", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-links-"));
  try {
    const directory = path.join(repositoryRoot, ".github", "workflows");
    await mkdir(directory, { recursive: true });
    const contents = "jobs:\n  build:\n    runs-on: ubuntu-latest\n";
    await writeFile(path.join(repositoryRoot, "shared-workflow.txt"), contents);
    await writeFile(path.join(directory, "regular.yaml"), contents);
    await writeFile(path.join(directory, "ignored.txt"), "not a workflow");
    await symlink("../../shared-workflow.txt", path.join(directory, "linked.yml"), "file");
    assert.deepEqual(await loadWorkflowFiles({ repositoryRoot }), {
      "linked.yml": contents,
      "regular.yaml": contents,
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("rejects external workflow symlinks without exposing their contents", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "workflow-links-"));
  const repositoryRoot = path.join(temporaryDirectory, "repository");
  // A shared prefix must not be mistaken for repository containment.
  const outsideDirectory = path.join(temporaryDirectory, "repository-outside");
  const outsideContents = "external-workflow-content-must-not-leak";
  try {
    const directory = path.join(repositoryRoot, ".github", "workflows");
    await mkdir(directory, { recursive: true });
    await mkdir(outsideDirectory);
    const outsideFile = path.join(outsideDirectory, "private.yml");
    await writeFile(outsideFile, outsideContents);
    await symlink(outsideFile, path.join(directory, "unsafe.yml"), "file");
    await assert.rejects(loadWorkflowFiles({ repositoryRoot }), (error) => {
      assert.equal(error.message,
        "Workflow: .github/workflows/unsafe.yml\nWorkflow file resolves outside the repository");
      assert.ok(!String(error.stack).includes(outsideContents));
      return true;
    });
    // Even an unreadable target (a directory) must fail the boundary check,
    // rather than reaching readFile.
    await rm(path.join(directory, "unsafe.yml"));
    await symlink(outsideDirectory, path.join(directory, "unsafe.yml"), "junction");
    await assert.rejects(loadWorkflowFiles({ repositoryRoot }),
      /Workflow: \.github\/workflows\/unsafe\.yml\nWorkflow file resolves outside the repository/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("reads node-version-file contents through an in-repository symlink", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "node-support-matrix-symlink-"),
  );
  const repositoryRoot = path.join(temporaryDirectory, "repository");
  const workflow = `
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
  `;

  try {
    await mkdir(repositoryRoot);
    await writeFile(path.join(repositoryRoot, "node-version.txt"), "v22.14.0\n");
    await symlink(
      "node-version.txt",
      path.join(repositoryRoot, ".nvmrc"),
      "file",
    );

    const nodeVersionFiles = await loadNodeVersionFiles(
      { "safe-symlink-workflow.yml": workflow },
      { repositoryRoot },
    );

    assert.equal(nodeVersionFiles[".nvmrc"], "v22.14.0\n");
    assert.deepEqual(workflowNodeMajors(workflow, { nodeVersionFiles }), [22]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("checker CLI requires symlink target coverage in an isolated repository", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "node-support-cli-target-"),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  // The CLI resolves its repository from its own script location, not cwd.
  // Copy the real contracts unchanged so a passing run exercises every check.
  await mkdir(path.join(repositoryRoot, "scripts"));
  await mkdir(path.join(repositoryRoot, ".github"));
  await mkdir(path.join(repositoryRoot, "config"));
  await Promise.all([
    "package.json",
    "scripts/check-node-support-matrix.mjs",
    "scripts/check-api-typecheck-rebuilds-db.mjs",
    ".github/workflows",
  ].map((relativePath) => cp(
    path.join(workspaceRoot, relativePath),
    path.join(repositoryRoot, relativePath),
    { recursive: true },
  )));

  const target = "config/node-version.txt";
  await writeFile(path.join(repositoryRoot, target), "22.14.0\n");
  await symlink(target, path.join(repositoryRoot, ".nvmrc"), "file");
  const workflowName = "cli-linked-node.yml";
  const both = 'paths: [".nvmrc", "config/node-version.txt"]';
  const referenceOnly = 'paths: [".nvmrc"]';
  const makeWorkflow = (pullRequest, push) => `on:
  pull_request:
    ${pullRequest}
  push:
    ${push}
jobs:
  compatibility:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - uses: actions/setup-node@v4
        with:
          node-version: 24
`;
  const runChecker = async (pullRequest, push) => {
    await writeFile(
      path.join(repositoryRoot, ".github/workflows", workflowName),
      makeWorkflow(pullRequest, push),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, "scripts/check-node-support-matrix.mjs")],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };

  for (const trigger of ["pull_request", "push"]) {
    await t.test(`${trigger} reference-only filter fails`, async () => {
      const result = await runChecker(
        trigger === "pull_request" ? referenceOnly : both,
        trigger === "push" ? referenceOnly : both,
      );
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(
        `.github/workflows/${workflowName} ${trigger}.paths must include "${target}"`,
      ), result.stderr);
      const coveredTrigger = trigger === "push" ? "pull_request" : "push";
      assert.ok(!result.stderr.includes(`${coveredTrigger}.paths must include`), result.stderr);
      assert.equal(result.stdout, "", "a rejected workflow must not report success");
    });
  }

  await t.test("reference-plus-target filters pass all CLI contracts", async () => {
    const result = await runChecker(both, both);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Node support matches \d+ workflow\(s\): 22, 24\n$/);
  });
});

test("version-file trigger filters cover the symlink and its resolved target", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "node-support-target-coverage-"),
  );
  const target = "config/node-version.txt";
  const workflowName = "linked-node.yml";
  const makeWorkflow = (pullRequest, push) => `
on:
  pull_request:
    ${pullRequest}
  push:
    ${push}
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: ./.nvmrc
`;

  try {
    await mkdir(path.join(repositoryRoot, "config"));
    await writeFile(path.join(repositoryRoot, target), "22.14.0\n");
    await symlink(target, path.join(repositoryRoot, ".nvmrc"), "file");

    const inputs = await loadNodeVersionFileInputs(
      { [workflowName]: makeWorkflow("", "") },
      { repositoryRoot },
    );
    assert.equal(inputs.nodeVersionFiles[".nvmrc"], "22.14.0\n");
    assert.equal(inputs.nodeVersionFileTargets[".nvmrc"], target);

    const check = (pullRequest, push) => checkNodeVersionFileTriggerCoverage({
      workflows: { [workflowName]: makeWorkflow(pullRequest, push) },
      nodeVersionFileTargets: inputs.nodeVersionFileTargets,
    });
    const both = 'paths: [".nvmrc", "config/node-version.txt"]';

    for (const trigger of ["pull_request", "push"]) {
      for (const [filter, uncoveredPath, kind] of [
        ['paths: [".nvmrc"]', target, "paths"],
        ['paths: ["config/node-version.txt"]', ".nvmrc", "paths"],
        ['paths: ["**", "!config/**"]', target, "paths"],
        ['paths-ignore: ["config/**"]', target, "paths-ignore"],
        ['paths-ignore: [".nvmrc"]', ".nvmrc", "paths-ignore"],
      ]) {
        await t.test(`${trigger} rejects ${filter}`, () => {
          assert.throws(
            () => check(
              trigger === "pull_request" ? filter : both,
              trigger === "push" ? filter : both,
            ),
            (error) => error.message.includes(
              `.github/workflows/${workflowName} ${trigger}.${kind} ${
                kind === "paths" ? "must include" : "must not exclude"
              } "${uncoveredPath}"`,
            ) && !error.message.includes(
              `${trigger === "push" ? "pull_request" : "push"}.paths must`,
            ),
          );
        });
      }
    }

    for (const filter of [
      both,
      'paths: [".nvmrc", "config/**"]',
      'paths: ["**", "!config/**", "config/node-version.txt"]',
      'paths-ignore: ["docs/**"]',
      "",
    ]) {
      await t.test(`accepts coverage with ${filter || "unrestricted triggers"}`, () => {
        assert.doesNotThrow(() => check(filter, filter));
      });
    }

    // A target edit changes the loaded Node version but must not make a
    // reference-only workflow's filters sufficient.
    await writeFile(path.join(repositoryRoot, target), "24.1.0\n");
    const updated = await loadNodeVersionFileInputs(
      { [workflowName]: makeWorkflow('paths: [".nvmrc"]', both) },
      { repositoryRoot },
    );
    assert.equal(updated.nodeVersionFiles[".nvmrc"], "24.1.0\n");
    assert.throws(() => checkNodeVersionFileTriggerCoverage({
      workflows: { [workflowName]: makeWorkflow('paths: [".nvmrc"]', both) },
      nodeVersionFileTargets: updated.nodeVersionFileTargets,
    }), /pull_request\.paths must include "config\/node-version\.txt"/);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

for (const directoryLinks of [false, true]) {
  test(`trigger filters cover intermediate ${directoryLinks ? "directory" : "file"} links`, async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "node-link-chain-"));
    const target = directoryLinks ? "versions/node-version.txt" : "config/node-version.txt";
    const dependencies = directoryLinks
      ? [".nvmrc", "config/current", "linked"]
      : [".nvmrc", "config/current"];
    const workflow = (trigger, filter) => `
on:
  pull_request:
    ${trigger === "pull_request" ? filter : ""}
  push:
    ${trigger === "push" ? filter : ""}
  pull_request_target:
    ${trigger === "pull_request_target" ? filter : ""}
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
`;
    try {
      await mkdir(path.join(repositoryRoot, "config"));
      if (directoryLinks) {
        await mkdir(path.join(repositoryRoot, "versions"));
        await symlink("versions", path.join(repositoryRoot, "linked"), "dir");
        await symlink("../linked", path.join(repositoryRoot, "config/current"), "dir");
      } else {
        await symlink("node-version.txt", path.join(repositoryRoot, "config/current"), "file");
      }
      await writeFile(path.join(repositoryRoot, target), "22.14.0\n");
      await symlink(
        directoryLinks ? "config/current/node-version.txt" : "config/current",
        path.join(repositoryRoot, ".nvmrc"), "file",
      );
      const inputs = await loadNodeVersionFileInputs(
        { "chain.yml": workflow("", "") }, { repositoryRoot },
      );
      assert.equal(inputs.nodeVersionFiles[".nvmrc"], "22.14.0\n");
      assert.equal(inputs.nodeVersionFileTargets[".nvmrc"], target);
      assert.deepEqual(inputs.nodeVersionFileDependencies[".nvmrc"], dependencies);
      const check = (trigger, filter) => checkNodeVersionFileTriggerCoverage({
        ...inputs, workflows: { "chain.yml": workflow(trigger, filter) },
      });
      const covered = [...dependencies, target];
      for (const trigger of ["pull_request", "push", "pull_request_target"]) {
        for (const dependency of dependencies.slice(1)) {
          for (const filter of [
            `paths: ${JSON.stringify(covered.filter((value) => value !== dependency))}`,
            `paths: ${JSON.stringify(["**", `!${dependency}`])}`,
            `paths-ignore: ${JSON.stringify([dependency])}`,
          ]) {
            assert.throws(() => check(trigger, filter), (error) =>
              error.message.includes(`${trigger}.paths`) &&
              error.message.includes(`"${dependency}"`));
          }
        }
        for (const filter of [
          `paths: ${JSON.stringify(covered)}`,
          'paths: ["**"]',
          `paths: ${JSON.stringify(["**", "!config/**", "config/current", target])}`,
          'paths-ignore: ["docs/**"]',
          "",
        ]) {
          assert.doesNotThrow(() => check(trigger, filter));
        }
      }
      // Retargeting only the intermediate link must still be covered.
      await writeFile(path.join(repositoryRoot, "config/alternate.txt"), "24.1.0\n");
      await rm(path.join(repositoryRoot, "config/current"));
      await symlink(
        directoryLinks ? "." : "alternate.txt",
        path.join(repositoryRoot, "config/current"),
        directoryLinks ? "dir" : "file",
      );
      if (directoryLinks) {
        await writeFile(path.join(repositoryRoot, "config/node-version.txt"), "24.1.0\n");
      }
      const updated = await loadNodeVersionFileInputs(
        { "chain.yml": workflow("", "") }, { repositoryRoot },
      );
      assert.equal(updated.nodeVersionFiles[".nvmrc"], "24.1.0\n");
      assert.ok(updated.nodeVersionFileDependencies[".nvmrc"].includes("config/current"));
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
}

for (const absolute of [false, true]) {
  test(`tracks a directory link before .. in an ${absolute ? "absolute" : "relative"} link target`, async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "node-link-parent-"));
    const workflow = (filter) => `
on:
  pull_request:
    ${filter}
  push:
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
`;
    try {
      await mkdir(path.join(repositoryRoot, "actual/subdir"), { recursive: true });
      await writeFile(path.join(repositoryRoot, "actual/node.txt"), "22.14.0\n");
      await symlink("actual/subdir", path.join(repositoryRoot, "alias"), "dir");
      const target = `alias${path.sep}..${path.sep}node.txt`;
      await symlink(
        absolute ? `${repositoryRoot}${path.sep}${target}` : target,
        path.join(repositoryRoot, ".nvmrc"), "file",
      );
      for (const decoyExists of [false, true]) {
        if (decoyExists) await writeFile(path.join(repositoryRoot, "node.txt"), "24.1.0\n");
        const inputs = await loadNodeVersionFileInputs(
          { "chain.yml": workflow("") }, { repositoryRoot },
        );
        assert.equal(inputs.nodeVersionFiles[".nvmrc"], "22.14.0\n");
        assert.equal(inputs.nodeVersionFileTargets[".nvmrc"], "actual/node.txt");
        assert.deepEqual(inputs.nodeVersionFileDependencies[".nvmrc"], [".nvmrc", "alias"]);
        const check = (filter) => checkNodeVersionFileTriggerCoverage({
          ...inputs, workflows: { "chain.yml": workflow(filter) },
        });
        assert.throws(
          () => check('paths: [".nvmrc", "actual/node.txt"]'),
          /pull_request\.paths must include "alias"/,
        );
        assert.doesNotThrow(() => check('paths: [".nvmrc", "actual/node.txt", "alias"]'));
      }
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
}

test("rejects a version-file chain that leaves the repository and links back inside", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-link-boundary-"));
  const repositoryRoot = path.join(directory, "repo");
  try {
    await mkdir(repositoryRoot);
    await writeFile(path.join(repositoryRoot, "version.txt"), "22.14.0\n");
    await symlink("repo/version.txt", path.join(directory, "outside"), "file");
    await symlink("../outside", path.join(repositoryRoot, ".nvmrc"), "file");
    await assert.rejects(
      loadNodeVersionFileInputs(
        { "chain.yml": "node-version-file: .nvmrc" }, { repositoryRoot },
      ),
      /node-version-file "\.nvmrc" resolves outside the repository/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects node-version-file symlinks outside the repository without exposing contents", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "node-support-matrix-symlink-"),
  );
  const repositoryRoot = path.join(temporaryDirectory, "repository");
  const outsideFile = path.join(temporaryDirectory, "outside.nvmrc");
  const outsideContents = "external-version-file-content-must-not-leak";
  const workflowName = "unsafe-symlink-workflow.yml";
  const workflow = `
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
  `;

  try {
    await mkdir(repositoryRoot);
    await writeFile(outsideFile, outsideContents);
    await symlink(outsideFile, path.join(repositoryRoot, ".nvmrc"), "file");

    await assert.rejects(
      loadNodeVersionFiles(
        { [workflowName]: workflow },
        { repositoryRoot },
      ),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          `Workflow: .github/workflows/${workflowName}`,
        ) &&
        error.message.includes(
          'node-version-file ".nvmrc" resolves outside the repository',
        ) &&
        !error.message.includes(outsideContents),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("reads a nested package.json engines.node range directly", () => {
  assert.deepEqual(
    workflowNodeMajors(
      `
        - uses: actions/setup-node@v4
          with:
            node-version-file: config/runtime/package.json
      `,
      {
        nodeVersionFiles: {
          "package.json": JSON.stringify({ engines: { node: "20" } }),
          "config/runtime/package.json": JSON.stringify({
            engines: { node: "^24.0.0 || ^22.0.0 || ^24.0.0" },
          }),
        },
      },
    ),
    [22, 24],
  );
});

test("reads package.json and asdf node-version-file declarations", () => {
  assert.deepEqual(
    workflowNodeMajors(
      `
        - uses: actions/setup-node@v4
          with:
            node-version-file: package.json
        - uses: actions/setup-node@v4
          with:
            node-version-file: .tool-versions
      `,
      {
        nodeVersionFiles: {
          "package.json": JSON.stringify({
            engines: { node: "^22.0.0 || ^24.0.0" },
          }),
          ".tool-versions": "nodejs 24.13.0\npython 3.13.0\n",
        },
      },
    ),
    [22, 24],
  );
});

for (const [label, laterEntry] of [
  ["equal versions", "nodejs 24.13.0"],
  ["conflicting versions", "nodejs 22.15.0"],
  ["a malformed later version", "nodejs private-malformed-node-version"],
  ["a later entry without a version", "nodejs"],
  ["a later entry with only a comment", "nodejs # private-comment"],
]) {
  test(`rejects duplicate .tool-versions nodejs entries with ${label}`, () => {
    const reference = "config/.tool-versions";
    const contents = [
      "# private-file-comment",
      "nodejs 24.13.0",
      "python 3.13.0",
      `  ${laterEntry}  `,
    ].join("\r\n");
    assert.throws(
      () =>
        workflowNodeMajors(
          `
            - uses: actions/setup-node@v4
              with:
                node-version-file: ${reference}
          `,
          { nodeVersionFiles: { [reference]: contents } },
        ),
      (error) =>
        error instanceof Error &&
        error.message ===
          `node-version-file "${reference}" must contain exactly one nodejs entry`,
    );
  });
}

for (const [label, entry] of [
  ["a bare entry", "nodejs"],
  ["whitespace only after the tool name", "  nodejs \t "],
  ["a comment instead of a version", "nodejs # private-node-comment"],
]) {
  test(`reports a missing .tool-versions nodejs version for ${label} without exposing contents`, () => {
    const reference = "config/.tool-versions";
    const contents = [
      "python private-python-version",
      entry,
      "ruby private-ruby-version",
    ].join("\r\n");
    assert.throws(
      () =>
        workflowNodeMajors(
          `
            - uses: actions/setup-node@v4
              with:
                node-version-file: ${reference}
          `,
          { nodeVersionFiles: { [reference]: contents } },
        ),
      (error) =>
        error instanceof Error &&
        error.message ===
          `node-version-file "${reference}" has a nodejs entry without a version; add an explicit numeric Node version after nodejs` &&
        !error.message.includes("private-") &&
        !error.message.includes("python") &&
        !error.message.includes("ruby"),
    );
  });
}

test("reports direct .tool-versions failures without exposing contents", () => {
  const reference = "config/.tool-versions";
  const workflow = `
    - uses: actions/setup-node@v4
      with:
        node-version-file: ${reference}
  `;

  const unrelatedVersions = ["python 3.13.0", "ruby 3.4.0"];
  const missingNodeVersions = `${unrelatedVersions.join("\n")}\n`;
  assert.throws(
    () =>
      workflowNodeMajors(workflow, {
        nodeVersionFiles: { [reference]: missingNodeVersions },
      }),
    (error) =>
      error instanceof Error &&
      error.message ===
        `node-version-file "${reference}" must declare a nodejs version` &&
      unrelatedVersions.every((version) => !error.message.includes(version)),
  );

  const malformedNodeVersion = "nodejs private-malformed-node-version";
  const malformedNodeVersions = [
    malformedNodeVersion,
    ...unrelatedVersions,
  ].join("\n");
  assert.throws(
    () =>
      workflowNodeMajors(workflow, {
        nodeVersionFiles: { [reference]: malformedNodeVersions },
      }),
    (error) =>
      error instanceof Error &&
      error.message ===
        `node-version-file "${reference}" contains an unsupported Node version; aliases are not supported because they cannot be compared to package.json engines.node` &&
      !error.message.includes(malformedNodeVersion) &&
      unrelatedVersions.every((version) => !error.message.includes(version)),
  );
});

test("accepts version file paths in pull request and push filters", () => {
  assert.deepEqual(
    checkNodeVersionFileTriggerCoverage({
      workflows: {
        "version-file-workflow.yml": `
on:
  pull_request:
    paths:
      - package.json
      - .nvmrc
  push:
    branches:
      - main
    paths: [package.json, .nvmrc]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
        `,
      },
    }),
    { workflows: ["version-file-workflow.yml"] },
  );
});

for (const [label, filter, failure] of [
  ["unfiltered", "", null],
  ["matching literal", 'paths: [".nvmrc"]', null],
  ["matching glob", 'paths: ["**/*.nvmrc"]', null],
  ["unrelated paths", 'paths: ["src/**"]', 'paths must include ".nvmrc"'],
  ["negative exclusion", 'paths: ["**", "!**/*.nvmrc"]', 'paths must include ".nvmrc"'],
  ["ordered re-inclusion", 'paths: ["**", "!**/*.nvmrc", ".nvmrc"]', null],
  ["ordered final exclusion", 'paths: ["**", "!**/*.nvmrc", ".nvmrc", "!.nvmrc"]', 'paths must include ".nvmrc"'],
  ["unrelated ignored paths", 'paths-ignore: ["docs/**"]', null],
  ["ignored literal", 'paths-ignore: [".nvmrc"]', 'paths-ignore must not exclude ".nvmrc"'],
  ["ignored glob", 'paths-ignore: ["**/*.nvmrc"]', 'paths-ignore must not exclude ".nvmrc"'],
]) {
  test(`validates pull_request_target version-file coverage: ${label}`, () => {
    const check = () => checkNodeVersionFileTriggerCoverage({
      workflows: {
        "target-version-file.yml": `
on:
  pull_request:
  push:
  pull_request_target:
    ${filter}
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
`,
      },
    });
    if (failure) {
      assert.throws(check, (error) =>
        error instanceof Error &&
        error.message.includes(
          `.github/workflows/target-version-file.yml pull_request_target.${failure}`,
        ),
      );
    } else {
      assert.deepEqual(check(), { workflows: ["target-version-file.yml"] });
    }
  });
}

test("matches supported glob forms in pull request and push paths filters", () => {
  assert.deepEqual(
    checkNodeVersionFileTriggerCoverage({
      workflows: {
        "version-file-glob-workflow.yml": `
on:
  pull_request:
    paths: ["**/*.nvmrc", "config/node-version.nvmr?"]
  push:
    paths: ["*.nvmrc", "config/[n]ode-version.nvmrc"]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - uses: actions/setup-node@v4
        with:
          node-version-file: config/node-version.nvmrc
        `,
      },
    }),
    { workflows: ["version-file-glob-workflow.yml"] },
  );
});

test("applies ordered negative paths patterns before accepting version-file coverage", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "version-file-negative-path-workflow.yml": `
on:
  pull_request:
    paths: ["**", "!**/*.nvmrc"]
  push:
    paths: ["**", "!**/*.nvmrc", ".nvmrc"]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        '.github/workflows/version-file-negative-path-workflow.yml pull_request.paths must include ".nvmrc"',
      ) &&
      !error.message.includes(
        '.github/workflows/version-file-negative-path-workflow.yml push.paths must include ".nvmrc"',
      ),
  );
});

test("accepts unrestricted pull request and push triggers for version files", () => {
  assert.deepEqual(
    checkNodeVersionFileTriggerCoverage({
      workflows: {
        "version-file-workflow.yml": `
on:
  pull_request:
  push:
    branches:
      - main
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
      },
    }),
    { workflows: ["version-file-workflow.yml"] },
  );
});

test("accepts flow-style trigger maps and lists for version files", () => {
  assert.deepEqual(
    checkNodeVersionFileTriggerCoverage({
      workflows: {
        "flow-map-version-file-workflow.yml": `
on: { 'pull_request': { paths: [package.json, .nvmrc] }, 'push': { paths: [.nvmrc] } }
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
        "flow-list-version-file-workflow.yml": `
on: [pull_request, push]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
      },
    }),
    {
      workflows: [
        "flow-list-version-file-workflow.yml",
        "flow-map-version-file-workflow.yml",
      ],
    },
  );
});

for (const quote of ["'", '"']) {
  test(`preserves version-file coverage with ${quote}-quoted flow-style path filters`, () => {
    const quoted = (value) => `${quote}${value}${quote}`;
    const filter = (key, paths) =>
      `{ ${quoted(key)}: [${paths.map(quoted).join(", ")}] }`;
    const included = filter("paths", ["package.json", ".nvmrc"]);
    const check = (pullRequest, push) =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "quoted-flow-path-version-file-workflow.yml": `
on: { ${quoted("pull_request")}: ${pullRequest}, ${quoted("push")}: ${push} }
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
        },
      });

    assert.deepEqual(check(included, included), {
      workflows: ["quoted-flow-path-version-file-workflow.yml"],
    });

    for (const trigger of ["pull_request", "push"]) {
      for (const [key, paths, reason] of [
        ["paths", ["package.json"], "must include"],
        ["paths", ["**", "!.nvmrc"], "must include"],
        ["paths-ignore", [".nvmrc"], "must not exclude"],
      ]) {
        const excluded = filter(key, paths);
        assert.throws(
          () => check(
            trigger === "pull_request" ? excluded : included,
            trigger === "push" ? excluded : included,
          ),
          (error) =>
            error instanceof Error &&
            error.message.includes(
              `.github/workflows/quoted-flow-path-version-file-workflow.yml ${trigger}.${key} ${reason} ".nvmrc" because it is referenced by node-version-file`,
            ),
        );
      }
    }
  });
}

test("accepts quoted flow-style trigger lists without path filters for version files", () => {
  assert.deepEqual(
    checkNodeVersionFileTriggerCoverage({
      workflows: {
        "quoted-flow-list-version-file-workflow.yml": `
on: ['pull_request', 'push']
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
      },
    }),
    { workflows: ["quoted-flow-list-version-file-workflow.yml"] },
  );
});

test("reports malformed flow-style trigger maps with workflow context", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "malformed-version-file-trigger-map.yml": `
on: { pull_request: {}, push: { paths: [.nvmrc] }
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        ".github/workflows/malformed-version-file-trigger-map.yml has invalid trigger syntax",
      ) &&
      error.message.includes("unterminated flow-style map or list"),
  );
});

test("reports malformed flow-style trigger lists with workflow context", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "malformed-version-file-trigger-list.yml": `
on: [pull_request, { push: {} }]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        ".github/workflows/malformed-version-file-trigger-list.yml has invalid trigger syntax",
      ) &&
      error.message.includes("trigger lists must contain only event names"),
  );
});

test("reports every malformed version-file workflow trigger together", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "malformed-version-file-trigger-map.yml": `
on: { pull_request: {}, push: { paths: [.nvmrc] }
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
          "malformed-version-file-trigger-list.yml": `
on: [pull_request, { push: {} }]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Node version file trigger coverage has drifted.") &&
      error.message.includes(
        ".github/workflows/malformed-version-file-trigger-map.yml has invalid trigger syntax",
      ) &&
      error.message.includes(
        ".github/workflows/malformed-version-file-trigger-list.yml has invalid trigger syntax",
      ) &&
      error.message.includes("unterminated flow-style map or list") &&
      error.message.includes("trigger lists must contain only event names"),
  );
});

for (const [lineEndingName, lineEnding] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`reports malformed multiline version-file triggers without workflow contents (${lineEndingName})`, () => {
    assert.throws(
      () =>
        checkNodeVersionFileTriggerCoverage({
          workflows: {
            "malformed-version-file-multiline-trigger.yml": `
on: |
  pull_request:
  push:
    paths:
      - .nvmrc
jobs:
  check:
    steps:
      - run: unrelated-workflow-content-must-not-leak
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `.replace(/\r?\n/g, lineEnding),
          },
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          ".github/workflows/malformed-version-file-multiline-trigger.yml has invalid trigger syntax",
        ) &&
        error.message.includes('multiline trigger value "on: |"') &&
        error.message.includes("multiline trigger values are not supported") &&
        !error.message.includes("unrelated-workflow-content-must-not-leak"),
    );
  });
}

test("reports duplicate top-level version-file triggers as syntax errors, not missing events", async (t) => {
  for (const [name, headers] of [
    ["block", "on:\n  pull_request:\non:\n  push:"],
    ["inline", "on: [pull_request]\non: {push: {}}"],
    ["quoted", "'on': [pull_request]\n\"on\": [push]"],
    ["mixed", "on:\n  pull_request:\n\"on\": [push]"],
  ]) {
    for (const [ending, newline] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
      await t.test(`${name} (${ending})`, () => {
        const workflow = guardedNodeWorkflow().replace(
          "on: [push, pull_request]",
          headers,
        ).replace(/\n/g, newline);
        assert.throws(
          () => checkNodeVersionFileTriggerCoverage({
            workflows: { "duplicate-triggers.yml": workflow },
          }),
          (error) => {
            assert.match(error.message, /\.github\/workflows\/duplicate-triggers\.yml has invalid trigger syntax/);
            assert.match(error.message, /duplicate top-level "on" declarations/);
            assert.doesNotMatch(error.message, /does not declare a .* trigger/);
            return true;
          },
        );
      });
    }
  }
});

test("keeps missing version-file trigger diagnostics when no top-level on exists", () => {
  assert.throws(
    () => checkNodeVersionFileTriggerCoverage({
      workflows: {
        "missing-triggers.yml": guardedNodeWorkflow().replace("on: [push, pull_request]\n", ""),
      },
    }),
    (error) => {
      assert.match(error.message, /does not declare a pull_request trigger/);
      assert.match(error.message, /does not declare a push trigger/);
      assert.doesNotMatch(error.message, /invalid trigger syntax/);
      return true;
    },
  );
});

test("requires every declared version file in each trigger's filters", async (t) => {
  const workflowName = "multiple-version-files.yml";
  const references = [".nvmrc", "config/.node-version"];
  const makeWorkflow = (pullRequest, push) => `
on:
  pull_request:
    ${pullRequest}
  push:
    ${push}
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - uses: actions/setup-node@v4
        with:
          node-version-file: config/.node-version
`;
  const check = (pullRequest, push) =>
    checkNodeVersionFileTriggerCoverage({
      workflows: { [workflowName]: makeWorkflow(pullRequest, push) },
    });
  const both = `paths: ${JSON.stringify(references)}`;

  for (const [filter, kind, requirement] of [
    ['paths: ["src/**"]', "paths", "must include"],
    ['paths-ignore: [".nvmrc", "config/.node-version"]', "paths-ignore", "must not exclude"],
  ]) {
    await t.test(`reports both files for both triggers with ${filter}`, () => {
      assert.throws(
        () => check(filter, filter),
        (error) => {
          assert.ok(error instanceof Error);
          assert.deepEqual(error.message.split("\n"), [
            "Node version file trigger coverage has drifted.",
            ...["pull_request", "push"].flatMap((trigger) =>
              references.map((reference) =>
                `- .github/workflows/${workflowName} ${trigger}.${kind} ${requirement} "${reference}" because it is referenced by node-version-file`,
              ),
            ),
          ]);
          return true;
        },
      );
    });
  }

  for (const filter of [
    both,
    'paths: [".nvmrc", "config/**"]',
    'paths-ignore: ["docs/**"]',
  ]) {
    await t.test(`accepts both files with ${filter}`, () => {
      assert.deepEqual(check(filter, filter), { workflows: [workflowName] });
    });
  }

  for (const trigger of ["pull_request", "push"]) {
    for (const reference of references) {
      const otherReference = references.find((entry) => entry !== reference);
      for (const [filter, kind, requirement] of [
        [`paths: ${JSON.stringify([otherReference])}`, "paths", "must include"],
        [`paths: ${JSON.stringify(["**", `!${reference}`])}`, "paths", "must include"],
        [`paths-ignore: ${JSON.stringify([reference])}`, "paths-ignore", "must not exclude"],
        [
          `paths-ignore: ${JSON.stringify([reference === ".nvmrc" ? "**/*.nvmrc" : "config/**"])}`,
          "paths-ignore",
          "must not exclude",
        ],
      ]) {
        await t.test(`${trigger} requires ${reference} with ${filter}`, () => {
          assert.throws(
            () => check(
              trigger === "pull_request" ? filter : both,
              trigger === "push" ? filter : both,
            ),
            (error) => {
              assert.equal(
                error.message,
                "Node version file trigger coverage has drifted.\n" +
                  `- .github/workflows/${workflowName} ${trigger}.${kind} ${requirement} "${reference}" because it is referenced by node-version-file`,
              );
              return true;
            },
          );
        });
      }
    }
  }
});

test("rejects a missing version file trigger path", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "version-file-workflow.yml": `
on:
  pull_request:
    paths:
      - package.json
  push:
    branches:
      - main
    paths:
      - package.json
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        '.github/workflows/version-file-workflow.yml pull_request.paths must include ".nvmrc"',
      ) &&
      error.message.includes(
        '.github/workflows/version-file-workflow.yml push.paths must include ".nvmrc"',
      ),
  );
});

test("rejects version files excluded by pull request and push paths-ignore filters", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "version-file-workflow.yml": `
on:
  pull_request:
    paths-ignore:
      - "**/*.nvmrc"
  push:
    branches:
      - main
    paths-ignore: [.nvmrc]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        '.github/workflows/version-file-workflow.yml pull_request.paths-ignore must not exclude ".nvmrc"',
      ) &&
      error.message.includes(
        '.github/workflows/version-file-workflow.yml push.paths-ignore must not exclude ".nvmrc"',
      ),
  );
});

test("shared workflow glob matching handles recursive, wildcard, and root-relative patterns", () => {
  assert.equal(
    matchesPathPattern("config/node-version.nvmrc", "**/node-version.nvmrc"),
    true,
  );
  assert.equal(
    matchesPathPattern("artifacts/top-dog-tricks", "artifacts/*"),
    true,
  );
  assert.equal(matchesPathPattern(".nvmrc", "./.nvmrc"), true);
  assert.equal(
    matchesPathPattern("artifacts/nested/top-dog-tricks", "artifacts/*"),
    false,
  );
});

test("version-file exclusions use shared recursive, wildcard, and root-relative glob matching", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "version-file-pattern-workflow.yml": `
on:
  pull_request:
    paths-ignore:
      - "**/node-version.nvmrc"
  push:
    paths-ignore:
      - "./config/node-version.nvmrc"
      - "config/*.nvmrc"
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: config/node-version.nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        '.github/workflows/version-file-pattern-workflow.yml pull_request.paths-ignore must not exclude "config/node-version.nvmrc"',
      ) &&
      error.message.includes(
        '.github/workflows/version-file-pattern-workflow.yml push.paths-ignore must not exclude "config/node-version.nvmrc"',
      ),
  );
});

test("version-file exclusions understand character classes and the plus operator", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "version-file-supported-ignore-workflow.yml": `
on:
  pull_request:
    paths-ignore: ["**/.nvmr[c]+"]
  push:
    paths-ignore: ["config/node-version.nv[m]rc"]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - uses: actions/setup-node@v4
        with:
          node-version-file: config/node-version.nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        '.github/workflows/version-file-supported-ignore-workflow.yml pull_request.paths-ignore must not exclude ".nvmrc"',
      ) &&
      error.message.includes(
        '.github/workflows/version-file-supported-ignore-workflow.yml push.paths-ignore must not exclude "config/node-version.nvmrc"',
      ),
  );
});

test("reports unsupported path-filter syntax with workflow and trigger context", () => {
  assert.throws(
    () =>
      checkNodeVersionFileTriggerCoverage({
        workflows: {
          "version-file-unsupported-path-workflow.yml": `
on:
  pull_request:
    paths: ["config/[node-version.nvmrc"]
  push:
    paths-ignore: ["@(config/)node-version.nvmrc"]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: config/node-version.nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        '.github/workflows/version-file-unsupported-path-workflow.yml pull_request.paths contains unsupported path filter pattern "config/[node-version.nvmrc": the character class is missing a closing ]',
      ) &&
      error.message.includes(
        '.github/workflows/version-file-unsupported-path-workflow.yml push.paths-ignore contains unsupported path filter pattern "@(config/)node-version.nvmrc": extglob operators are not supported',
      ),
  );
});

test("aggregates every invalid path filter across workflows and preserves valid-filter diagnostics", () => {
  const invalidPatterns = [
    ["config/[node", "the character class is missing a closing ]"],
    ["@(config/)node", "extglob operators are not supported"],
    ["config/{node,version}", "brace expansion is not supported"],
  ];
  const workflows = {};
  const expected = ["Node version file trigger coverage has drifted."];
  for (const filterName of ["paths", "paths-ignore"]) {
    const workflowName = `invalid-${filterName}.yml`;
    const filters = JSON.stringify([
      invalidPatterns[0][0],
      filterName === "paths" ? "src/**" : ".nvmrc",
      ...invalidPatterns.slice(1).map(([pattern]) => pattern),
    ]);
    workflows[workflowName] = `
on:
  pull_request:
    ${filterName}: ${filters}
  push:
    ${filterName}: ${filters}
  pull_request_target:
    ${filterName}: ${filters}
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
`;
    for (const trigger of ["pull_request", "push", "pull_request_target"]) {
      for (const [pattern, reason] of invalidPatterns) {
        expected.push(
          `- .github/workflows/${workflowName} ${trigger}.${filterName} contains unsupported path filter pattern "${pattern}": ${reason}`,
        );
      }
    }
  }
  workflows["valid-filters.yml"] = `
on:
  pull_request:
    paths: ["src/**"]
  push:
    paths-ignore: [".nvmrc"]
jobs:
  check:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
`;
  expected.push(
    '- .github/workflows/valid-filters.yml pull_request.paths must include ".nvmrc" because it is referenced by node-version-file',
    '- .github/workflows/valid-filters.yml push.paths-ignore must not exclude ".nvmrc" because it is referenced by node-version-file',
  );
  assert.throws(
    () => checkNodeVersionFileTriggerCoverage({ workflows }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, expected.join("\n"));
      return true;
    },
  );
});

test("reports a missing version file with workflow and file context", () => {
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0" } },
        workflows: {
          "missing-version-file-workflow.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version-file: .nvmrc
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Workflow: .github/workflows/missing-version-file-workflow.yml",
      ) &&
      error.message.includes(
        'node-version-file ".nvmrc" could not be read',
      ),
  );
});

test("reports invalid package.json content without exposing its contents", () => {
  const invalidPackageJson = `{"engines":{"node":"^22.0.0"},"private":"package-content-must-not-leak"`;
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0" } },
        workflows: {
          "invalid-package-json-workflow.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version-file: package.json
          `,
        },
        nodeVersionFiles: { "package.json": invalidPackageJson },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Workflow: .github/workflows/invalid-package-json-workflow.yml",
      ) &&
      error.message.includes(
        'node-version-file "package.json" must contain a valid package.json',
      ) &&
      !error.message.includes("package-content-must-not-leak"),
  );
});

test("reports a .tool-versions file without nodejs", () => {
  const toolVersions = "python 3.13.0\nruby 3.4.0\n";
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0" } },
        workflows: {
          "missing-tool-versions-node-workflow.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version-file: .tool-versions
          `,
        },
        nodeVersionFiles: { ".tool-versions": toolVersions },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Workflow: .github/workflows/missing-tool-versions-node-workflow.yml",
      ) &&
      error.message.includes(
        'node-version-file ".tool-versions" must declare a nodejs version',
      ) &&
      !error.message.includes("python 3.13.0") &&
      !error.message.includes("ruby 3.4.0"),
  );
});

test("reports malformed raw version files without exposing their contents", () => {
  const malformedVersion = "malformed-version-content-must-not-leak";
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0" } },
        workflows: {
          "malformed-raw-version-workflow.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version-file: .nvmrc
          `,
        },
        nodeVersionFiles: { ".nvmrc": malformedVersion },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Workflow: .github/workflows/malformed-raw-version-workflow.yml",
      ) &&
      error.message.includes(
        'node-version-file ".nvmrc" contains an unsupported Node version',
      ) &&
      !error.message.includes(malformedVersion),
  );
});

test("rejects aliases instead of skipping validation", () => {
  assert.throws(
    () =>
      workflowNodeMajors(`
        - uses: actions/setup-node@v4
          with:
            node-version: lts/*
      `),
    (error) =>
      error instanceof Error &&
      error.message.includes("aliases are not supported"),
  );
});

test("reports the workflow name and both version sets when fixtures drift", () => {
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
        workflows: {
          "other-node-workflow.yml": `
            matrix:
              include:
                - host: Linux
                  node: 22
                - host: Windows
                  node: 25
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Supported Node versions from package.json: [22,24]",
      ) &&
      error.message.includes(
        "Workflow: .github/workflows/other-node-workflow.yml",
      ) &&
      error.message.includes("Declared Node versions: [22,25]"),
  );
});

test("reports the workflow name and both version sets for a mismatched version file", () => {
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
        workflows: {
          "version-file-workflow.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version-file: .nvmrc
          `,
        },
        nodeVersionFiles: { ".nvmrc": "25.0.0\n" },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Supported Node versions from package.json: [22,24]",
      ) &&
      error.message.includes(
        "Workflow: .github/workflows/version-file-workflow.yml",
      ) &&
      error.message.includes("Declared Node versions: [25]"),
  );
});

test("reports the workflow name and both version sets for an alias", () => {
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
        workflows: {
          "alias-node-workflow.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version: lts/*
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Supported Node versions from package.json: [22,24]",
      ) &&
      error.message.includes(
        "Workflow: .github/workflows/alias-node-workflow.yml",
      ) &&
      error.message.includes("Declared Node versions: []") &&
      error.message.includes("aliases are not supported"),
  );
});

test("requires both supported Node versions in the frontend workflow", () => {
  assert.deepEqual(
    checkNodeSupportMatrix({
      packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
      workflows: {
        "frontend-typecheck-refresh.yml": `
          strategy:
            matrix:
              node: [22, 24]
          - uses: actions/setup-node@v4
            with:
              node-version: \${{ matrix.node }}
        `,
      },
    }),
    {
      supported: [22, 24],
      workflows: [
        {
          workflow: "frontend-typecheck-refresh.yml",
          matrix: [22, 24],
          policy: "exact",
        },
      ],
    },
  );
});

test("allows the explicit newsletter workflow Node 24 policy", () => {
  assert.deepEqual(
    checkNodeSupportMatrix({
      packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
      workflows: {
        "newsletter-funnel-clickhouse.yml": `
          - uses: actions/setup-node@v4
            with:
              node-version: 24
        `,
      },
    }),
    {
      supported: [22, 24],
      workflows: [
        {
          workflow: "newsletter-funnel-clickhouse.yml",
          matrix: [24],
          policy: "allow-list",
        },
      ],
    },
  );
});

test("keeps the browser layout workflow pinned to its explicit Node 24 policy", () => {
  const check = (version) => checkNodeSupportMatrix({
    packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
    workflows: {
      "prize-layout.yml": `
        - uses: actions/setup-node@v4
          with:
            node-version: ${version}
      `,
    },
  });
  assert.deepEqual(check(24).workflows, [{
    workflow: "prize-layout.yml",
    matrix: [24],
    policy: "allow-list",
  }]);
  assert.throws(() => check(22), /Node support and workflow declarations have drifted/);
  assert.throws(() => check(26), /Node support and workflow declarations have drifted/);
});

test("requires every supported Node major in the welcome recovery PostgreSQL matrix", () => {
  assert.deepEqual(
    checkNodeSupportMatrix({
      packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
      workflows: {
        "welcome-recovery-postgres.yml": `
          strategy:
            matrix:
              node: [22, 24]
              version: [14, 15, 16, 17, 18]
          - uses: actions/setup-node@v4
            with:
              node-version: \${{ matrix.node }}
        `,
      },
    }),
    {
      supported: [22, 24],
      workflows: [
        {
          workflow: "welcome-recovery-postgres.yml",
          matrix: [22, 24],
          policy: "exact",
        },
      ],
    },
  );
});

test("rejects missing or unsupported Node majors in the welcome recovery PostgreSQL matrix", () => {
  for (const versions of ["[22]", "[24]", "[26]", "[22, 24, 26]"]) {
    assert.throws(
      () =>
        checkNodeSupportMatrix({
          packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
          workflows: {
            "welcome-recovery-postgres.yml": `
              strategy:
                matrix:
                  node: ${versions}
              - uses: actions/setup-node@v4
                with:
                  node-version: \${{ matrix.node }}
            `,
          },
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Workflow: .github/workflows/welcome-recovery-postgres.yml",
        ) &&
        error.message.includes("Policy: exact"),
      `Node ${versions} must match the supported Node majors exactly`,
    );
  }
});

test("rejects pinned setup-node versions despite a complete recovery Node matrix", async (t) => {
  const workflowName = "welcome-recovery-postgres.yml";
  const workflow = await readFile(
    path.join(workspaceRoot, ".github/workflows", workflowName),
    "utf8",
  );
  for (const version of ["22", "24"]) {
    await t.test(`setup-node pinned to Node ${version}`, () => {
      const mutated = workflow.replace(
        "node-version: ${{ matrix.node }}",
        `node-version: ${version}`,
      );
      assert.notEqual(mutated, workflow);
      assert.match(mutated, /node: \[22, 24\]/);
      assert.throws(
        () => checkNodeSupportMatrix({
          packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
          workflows: { [workflowName]: mutated },
        }),
        (error) => {
          assert.match(error.message, /Workflow: \.github\/workflows\/welcome-recovery-postgres\.yml/);
          assert.match(error.message, /actions\/setup-node must use node-version: \$\{\{ matrix\.node \}\}/);
          return true;
        },
      );
    });
  }
});

test("the checked-in PostgreSQL recovery workflow runs the full Node matrix with bounded jobs", async () => {
  const workflow = await readFile(
    path.join(workspaceRoot, ".github/workflows/welcome-recovery-postgres.yml"),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  );
  const result = checkNodeSupportMatrix({
    packageJson,
    workflows: { "welcome-recovery-postgres.yml": workflow },
  });
  assert.deepEqual(result.workflows[0].matrix, supportedNodeMajors(packageJson.engines.node));
  assert.equal(result.workflows[0].policy, "exact");
  assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(workflow, /name: Welcome recovery fixture \(PostgreSQL \$\{\{ matrix\.version \}\}, Node \$\{\{ matrix\.node \}\}\)/);
  assert.match(workflow, /version: \[14, 15, 16, 17, 18\]/);
  assert.doesNotMatch(workflow, /^\s+(?:include|exclude):/m);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /image: postgres:\$\{\{ matrix\.version \}\}/);
  assert.match(workflow, /run: pnpm install --frozen-lockfile/);
  assert.match(workflow, /run: pnpm --filter @workspace\/db exec drizzle-kit push --config drizzle\.config\.ts/);
  assert.match(workflow, /run: pnpm --filter @workspace\/api-server run test:subscriber-notifications/);
});

test("PostgreSQL recovery path filters cover fixture dependencies on pull requests and pushes", async (t) => {
  const workflow = await readFile(
    path.join(workspaceRoot, ".github/workflows/welcome-recovery-postgres.yml"), "utf8",
  );
  // Include transitive route imports: the fixture bundles admin and submissions,
  // not just engagement. Shared helper directories also cover future extractions.
  const requiredPaths = [
    ".github/workflows/welcome-recovery-postgres.yml",
    ".npmrc",
    "artifacts/api-server/package.json",
    ...["admin", "engagement", "reviewQueue", "submissions",
      "subscriberNotifications.integration.test"].map(
      (name) => `artifacts/api-server/src/routes/${name}.ts`,
    ),
    ...["adminSession", "durableVideoThumbnail", "entryUploadRegistry",
      "firstContest", "integrations", "mediaProcessing", "newsletterFunnelAnalytics",
      "newsletterFunnelNotifications", "objectAcl", "objectStorage",
      "requestLogSerializers", "subscriberEmail", "subscriberTokens",
      "temporaryDirectoryCleanup", "uploadValidation", "videoAnalysis",
      "videoThumbnail", "videoTitleStyle"].map(
      (name) => `artifacts/api-server/src/lib/${name}.ts`,
    ),
    "artifacts/api-server/test.mjs",
    "artifacts/api-server/test-discovery.mjs",
    "artifacts/api-server/tsconfig.json",
    "lib/api-zod/package.json",
    "lib/api-zod/src/index.ts",
    "lib/api-zod/src/generated/api.ts",
    "lib/db/drizzle.config.ts",
    "lib/db/package.json",
    "lib/db/scripts/normalize-subscriber-emails.mjs",
    "lib/db/src/index.ts",
    "lib/db/src/schema/index.ts",
    "lib/db/src/schema/subscribers.ts",
    "lib/integrations-gemini-ai/package.json",
    "lib/integrations-gemini-ai/src/index.ts",
    "lib/integrations-openai-ai-server/package.json",
    "lib/integrations-openai-ai-server/src/index.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
  ];
  for (const trigger of ["pull_request", "push"]) {
    await t.test(trigger, () => {
      const section = workflow.match(
        new RegExp(`^  ${trigger}:\\n([\\s\\S]*?)(?=^  \\w|^\\S)`, "m"),
      )?.[1];
      assert.ok(section, `${trigger} trigger must remain present`);
      const paths = section.match(/^    paths:\n((?:      - .+\n)+)/m)?.[1];
      assert.ok(paths, `${trigger} must retain scoped path filters`);
      const patterns = [...paths.matchAll(/^      - "([^"]+)"$/gm)].map((m) => m[1]);
      const triggersFor = (file) => patterns.reduce((included, pattern) => {
        const negative = pattern.startsWith("!");
        return matchesPathPattern(file, negative ? pattern.slice(1) : pattern)
          ? !negative : included;
      }, false);
      for (const file of requiredPaths) {
        assert.ok(triggersFor(file), `${trigger} must trigger PostgreSQL recovery for ${file}`);
      }
      for (const file of [
        "README.md", "artifacts/top-dog-tricks/src/App.tsx",
        "artifacts/ghost-town-rescue/src/App.tsx",
        ".github/workflows/native-process-identity.yml",
      ]) {
        assert.equal(triggersFor(file), false, `${trigger} must remain scoped: ${file}`);
      }
    });
  }
  assert.match(workflow, /^  push:\n    branches:\n      - main\n/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  schedule:/m);
});

test("rejects a frontend workflow switch to another supported major", () => {
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
        workflows: {
          "frontend-typecheck-refresh.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version: 22
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "Workflow: .github/workflows/frontend-typecheck-refresh.yml",
      ) &&
      error.message.includes("Declared Node versions: [22]"),
  );
});

test("unknown workflows require an exact version match", () => {
  assert.throws(
    () =>
      checkNodeSupportMatrix({
        packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
        workflows: {
          "new-workflow.yml": `
            - uses: actions/setup-node@v4
              with:
                node-version: 24
          `,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Workflow: .github/workflows/new-workflow.yml") &&
      error.message.includes("Declared Node versions: [24]") &&
      error.message.includes("Policy: exact"),
  );
});

test("legacy single-workflow calls retain their matrix result", () => {
  assert.deepEqual(
    checkNodeSupportMatrix({
      packageJson: { engines: { node: "^24.0.0 || ^22.0.0 || ^24.1.0" } },
      workflow: `
        matrix:
          include:
            - host: Linux
              node: 22
            - host: Windows
              node: 24
      `,
    }),
    { supported: [22, 24], matrix: [22, 24] },
  );
});

test("accepts matching independent package and workflow fixtures", () => {
  assert.deepEqual(
    checkNodeSupportMatrix({
      packageJson: { engines: { node: "^24.0.0 || ^22.0.0 || ^24.1.0" } },
      workflows: {
        "other-node-workflow.yml": `
          matrix:
            include:
              - host: Linux
                node: 22
              - host: Windows
                node: 24
        `,
      },
    }),
    {
      supported: [22, 24],
      workflows: [
        {
          workflow: "other-node-workflow.yml",
          matrix: [22, 24],
          policy: "exact",
        },
      ],
    },
  );
});

test("accepts the native process workflow trigger contract", () => {
  assert.deepEqual(
    checkNativeProcessWorkflowContract({
      workflows: {
        "native-process-identity.yml": validNativeProcessWorkflow,
        "frontend-typecheck-refresh.yml": "on:\n  workflow_dispatch:\n",
      },
    }),
    {
      workflow: "native-process-identity.yml",
      scheduledWorkflows: ["native-process-identity.yml"],
      scheduleEntries: 1,
    },
  );
});

test("accepts the transition interruption fixture as the native probe boundary", () => {
  const probe = validNativeProcessProbe.replace(
    "if (testNativeTransitionLockOwnerExitProbe) {",
    "if (testNativeTransitionLockOwnerExitProbe || runNativeTransitionInterruptionFixture) {",
  );
  assert.deepEqual(
    checkNativeProcessProbeContract({ probe }),
    { phases: requiredNativeProcessProbePhases },
  );
  assert.throws(
    () => checkNativeProcessProbeContract({
      probe: probe.replace('await exposeNativeProcessProbePhase(phase);', ""),
    }),
    /must emit the fixed phase/,
  );
});

test("checked-in workflows retain both independent scheduled audits", async () => {
  const workflows = await loadWorkflowFiles();
  assert.deepEqual(checkNativeProcessWorkflowContract({ workflows }), {
    workflow: "native-process-identity.yml",
    scheduledWorkflows: [
      "native-process-identity.yml",
      "required-merge-checks.yml",
    ],
    scheduleEntries: 1,
  });
});

test("permits the daily merge-check audit alongside the native process schedule", async () => {
  const auditWorkflow = await readFile(
    path.join(workspaceRoot, ".github/workflows/required-merge-checks.yml"),
    "utf8",
  );
  for (const audit of [
    auditWorkflow,
    "'on': { 'schedule': [{ 'cron': '23 8 * * *' }], 'workflow_dispatch': {} }\n",
  ]) {
    const workflows = {
      "native-process-identity.yml": validNativeProcessWorkflow,
      "required-merge-checks.yml": audit,
    };
    assert.deepEqual(checkNativeProcessWorkflowContract({ workflows }), {
      workflow: "native-process-identity.yml",
      scheduledWorkflows: [
        "native-process-identity.yml",
        "required-merge-checks.yml",
      ],
      scheduleEntries: 1,
    });

    // An allowed audit must not exempt other files with the same schedule.
    assert.throws(
      () => checkNativeProcessWorkflowContract({
        workflows: { ...workflows, "unexpected-audit.yml": audit },
      }),
      /scheduled workflows may only be.*\.github\/workflows\/unexpected-audit\.yml/,
    );

    // The independent daily audit cannot substitute for the native schedule.
    assert.throws(
      () => checkNativeProcessWorkflowContract({
        workflows: {
          ...workflows,
          "native-process-identity.yml": validNativeProcessWorkflow.replace(
            '  schedule:\n    - cron: "17 4 * * 1"\n',
            "",
          ),
        },
      }),
      /exactly one recurring schedule trigger \(found 0\)/,
    );
  }
});

test("accepts every native process host, Node major, and probe", () => {
  assert.deepEqual(
    checkNativeProcessWorkflowCoverage({
      workflow: validNativeProcessWorkflowCoverage,
    }),
    {
      workflow: "native-process-identity.yml",
      matrix: requiredNativeProcessMatrixEntries,
      probes: [
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-transition-exit",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-timeout",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-descendant-lifecycle",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:recovery",
        "pnpm run check:api-typecheck-rebuilds-libs:interrupted-publication",
      ],
    },
  );
});

test("requires the stale-lock probe to emit every fixed phase", () => {
  assert.deepEqual(
    checkNativeProcessProbeContract({ probe: validNativeProcessProbe }),
    { phases: requiredNativeProcessProbePhases },
  );
  for (const phase of requiredNativeProcessProbePhases) {
    assert.throws(
      () =>
        checkNativeProcessProbeContract({
          probe: validNativeProcessProbe.replace(
            new RegExp(
              `  (?:let )?phase = "${phase}";\\n  await exposeNativeProcessProbePhase\\(phase\\);\\n`,
            ),
            "",
          ),
        }),
      new RegExp(`must emit the fixed phase "${phase}"`),
    );
  }
});

test("rejects unsafe or arbitrary native process probe phases", () => {
  assert.throws(
    () =>
      checkNativeProcessProbeContract({
        probe: validNativeProcessProbe.replace(
          '"filesystem-cleanup"',
          '"unsafe phase"',
        ),
      }),
    /phases must be safe labels/,
  );
  assert.throws(
    () =>
      checkNativeProcessProbeContract({
        probe: validNativeProcessProbe.replace(
          '"filesystem-cleanup"',
          '"arbitrary-phase"',
        ),
      }),
    /must keep the native process probe phases fixed/,
  );
  assert.throws(
    () =>
      checkNativeProcessProbeContract({
        probe: validNativeProcessProbe.replace(
          "if (!nativeProcessProbePhases.has(phase))",
          "if (false)",
        ),
      }),
    /phases must be emitted as the phase output/,
  );
});

test("derives a diagnostics artifact name for every native host and Node major", () => {
  const artifactNames = nativeProcessDiagnosticArtifactNames({
    workflow: validNativeProcessWorkflowCoverage,
    matrixEntries: representativeNativeProcessMatrixEntries,
  });

  assert.deepEqual(
    artifactNames.map(({ entry, name }) => ({
      entry,
      name,
    })),
    representativeNativeProcessMatrixEntries.map((entry) => ({
      entry,
      name: `native-process-diagnostics-${entry.os}-node-${entry.node}`,
    })),
  );
  assert.equal(
    new Set(artifactNames.map(({ name }) => name)).size,
    representativeNativeProcessMatrixEntries.length,
  );
});

test("rejects every native process coverage row omitted from the workflow", () => {
  for (const { host, os, node } of requiredNativeProcessMatrixEntries) {
    const row = `          - host: ${host}\n            os: ${os}\n            node: ${node}\n`;
    assert.throws(
      () =>
        checkNativeProcessWorkflowCoverage({
          workflow: validNativeProcessWorkflowCoverage.replace(row, ""),
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(`${host} on ${os} with Node.js ${node}`),
      `expected the workflow to require ${host} on ${os} with Node.js ${node}`,
    );
  }
});

test("rejects duplicate macOS native process matrix entries", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          - host: macOS\n            os: macos-latest\n            node: 24\n",
          "          - host: macOS\n            os: macos-latest\n            node: 24\n          - host: macOS\n            os: macos-latest\n            node: 24\n",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "must not duplicate native process matrix entries",
      ) &&
      error.message.includes("macOS on macos-latest with Node.js 24"),
  );
});

test("rejects duplicate Windows native process matrix entries", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          - host: Windows\n            os: windows-latest\n            node: 22\n",
          "          - host: Windows\n            os: windows-latest\n            node: 22\n          - host: Windows\n            os: windows-latest\n            node: 22\n",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "must not duplicate native process matrix entries",
      ) &&
      error.message.includes("Windows on windows-latest with Node.js 22"),
  );
});

test("requires the Node support regression gate before synchronization and native probes", () => {
  assert.deepEqual(
    checkNativeProcessWorkflowStepOrder({
      workflow: validNativeProcessWorkflowCoverage,
    }),
    {
      workflow: "native-process-identity.yml",
      regression: "pnpm run test:node-support-matrix",
      synchronization: "pnpm run check:node-support-matrix",
      probes: [
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-transition-exit",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-timeout",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-descendant-lifecycle",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:recovery",
        "pnpm run check:api-typecheck-rebuilds-libs:interrupted-publication",
      ],
    },
  );
});

test("requires the Node support regression gate in every native job", () => {
  assert.deepEqual(
    checkNativeProcessWorkflowStepOrder({
      workflow: validMultiJobNativeProcessWorkflowCoverage,
    }),
    {
      workflow: "native-process-identity.yml",
      regression: "pnpm run test:node-support-matrix",
      synchronization: "pnpm run check:node-support-matrix",
      probes: [
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-transition-exit",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-timeout",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-descendant-lifecycle",
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:recovery",
        "pnpm run check:api-typecheck-rebuilds-libs:interrupted-publication",
      ],
    },
  );
});

test("reports a synchronization-only job that bypasses its own Node support regression gate", () => {
  const synchronizationStep =
    "      - name: Verify Node support matches the CI matrix\n        id: node-support-matrix-contract\n        run: pnpm run check:node-support-matrix\n";
  const synchronizationGate =
    "      - name: Run Node support matrix regression tests for synchronization\n        run: pnpm run test:node-support-matrix\n";
  const probesOnlyWorkflow = validNativeProcessWorkflowCoverage.replace(
    synchronizationStep,
    "",
  );
  assert.notEqual(probesOnlyWorkflow, validNativeProcessWorkflowCoverage);
  assert.doesNotMatch(probesOnlyWorkflow, /run: pnpm run check:node-support-matrix/);
  const synchronizationJob = `  matrix-synchronization:
    runs-on: ubuntu-latest
    steps:
${synchronizationGate}${synchronizationStep}`;
  const splitWorkflow = `${probesOnlyWorkflow}${synchronizationJob}`;

  assert.doesNotThrow(() =>
    checkNativeProcessWorkflowStepOrder({ workflow: splitWorkflow }),
  );
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: splitWorkflow.replace(synchronizationGate, ""),
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /job "matrix-synchronization" must run the Node support matrix regression test step \(pnpm run test:node-support-matrix\)/,
      );
      assert.doesNotMatch(error.message, /job "process-identity"/);
      return true;
    },
  );
});

test("requires an explicit supported repeat count on each owner-exit probe", () => {
  const setting = '          API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS: "3"';
  for (const value of ["2", '"3"', "'10'"]) {
    assert.doesNotThrow(() => checkNativeProcessWorkflowStepOrder({
      workflow: validNativeProcessWorkflowCoverage.replace(
        setting,
        `          API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS: ${value}`,
      ),
    }));
  }
  for (const value of [null, '""', "1", "0", "-1", "11", "99999999999999999999", "2.5", "three", "true", "03", '" 3 "', "${{ matrix.iterations }}"]) {
    assert.throws(() => checkNativeProcessWorkflowStepOrder({
      workflow: validNativeProcessWorkflowCoverage.replace(
        setting,
        value === null ? "" : `          API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS: ${value}`,
      ),
    }), /job "process-identity".*API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS.*between 2 and 10/, String(value));
  }
});

test("one native job cannot supply another job's owner-exit repeat setting", () => {
  const job = validNativeProcessWorkflowCoverage.slice(
    validNativeProcessWorkflowCoverage.indexOf("  process-identity:\n"),
  );
  const mac = job.replace("  process-identity:", "  macos-probes:");
  const windows = job.replace("  process-identity:", "  windows-probes:");
  const setting = '          API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS: "3"';
  assert.doesNotThrow(() => checkNativeProcessWorkflowStepOrder({
    workflow: `jobs:\n${mac}${windows}`,
  }));
  for (const missingJob of ["macos-probes", "windows-probes"]) {
    assert.throws(() => checkNativeProcessWorkflowStepOrder({
      workflow: `jobs:\n${missingJob === "macos-probes" ? mac.replace(setting, "") : mac}${missingJob === "windows-probes" ? windows.replace(setting, "") : windows}`,
    }), new RegExp(`job "${missingJob}".*API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS`));
  }
});

test("reports the native job that bypasses the Node support regression gate", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validMultiJobNativeProcessWorkflowCoverage.replace(
          "      - name: Run Node support matrix regression tests for recovery probes\n        id: recovery-node-support-matrix-tests\n        run: pnpm run test:node-support-matrix\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes('job "recovery-probes"') &&
      error.message.includes("pnpm run test:node-support-matrix"),
  );
});

test("rejects a native process workflow with a missing Node support regression gate", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "      - name: Run Node support matrix regression tests\n        id: node-support-matrix-tests\n        run: pnpm run test:node-support-matrix\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Node support matrix regression test step") &&
      error.message.includes("pnpm run test:node-support-matrix"),
  );
});

test("rejects a Node support regression gate moved after synchronization", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validNativeProcessWorkflowCoverage
          .replace(
            "      - name: Run Node support matrix regression tests\n        id: node-support-matrix-tests\n        run: pnpm run test:node-support-matrix\n",
            "",
          )
          .replace(
            "      - name: Verify Node support matches the CI matrix\n        id: node-support-matrix-contract\n        run: pnpm run check:node-support-matrix\n",
            "      - name: Verify Node support matches the CI matrix\n        id: node-support-matrix-contract\n        run: pnpm run check:node-support-matrix\n      - name: Run Node support matrix regression tests\n        id: node-support-matrix-tests\n        run: pnpm run test:node-support-matrix\n",
          ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Node support matrix regression test step") &&
      error.message.includes("before the synchronization check"),
  );
});

test("rejects a Node support regression gate moved after a native probe", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validNativeProcessWorkflowCoverage
          .replace(
            "      - name: Run Node support matrix regression tests\n        id: node-support-matrix-tests\n        run: pnpm run test:node-support-matrix\n",
            "",
          )
          .replace(
            "      - name: Verify stale lock takeover\n        id: native-process-identity\n        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native\n",
            "      - name: Verify stale lock takeover\n        id: native-process-identity\n        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native\n      - name: Run Node support matrix regression tests\n        id: node-support-matrix-tests\n        run: pnpm run test:node-support-matrix\n",
          ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Node support matrix regression test step") &&
      error.message.includes("before native probe"),
  );
});

test("rejects a native process workflow missing the matrix Node runtime setup", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.node }}\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "actions/setup-node@v4 with node-version: ${{ matrix.node }}",
      ),
  );
});

test("rejects a native process workflow with a non-matrix Node runtime setup", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          node-version: \${{ matrix.node }}",
          "          node-version: 24",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "actions/setup-node@v4 with node-version: ${{ matrix.node }}",
      ),
  );
});

test("rejects a native process workflow with setup-node after a native probe", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validNativeProcessWorkflowCoverage
          .replace(
            "      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.node }}\n",
            "",
          )
          .replace(
            "        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native\n",
            "        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.node }}\n",
          ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "actions/setup-node@v4 step must run before native probe",
      ),
  );
});

test("rejects duplicate setup-node steps in a native job", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowStepOrder({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "      - name: Verify stale lock takeover\n",
          "      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.node }}\n      - name: Verify stale lock takeover\n",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "must declare only one actions/setup-node step",
      ) &&
      error.message.includes("duplicate setup-node steps"),
  );
});

test("rejects a native process workflow missing a required host and Node entry", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          - host: Windows\n            os: windows-latest\n            node: 24\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Windows on windows-latest with Node.js 24"),
  );
});

test("explains a native process matrix row with a missing runner", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          - host: Windows\n            os: windows-latest\n            node: 24\n",
          "          - host: Windows\n            node: 24\n",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "native process matrix rows are incomplete or unsupported",
      ) &&
      error.message.includes(
        "host: Windows, runner: <missing>, Node: 24",
      ) &&
      !error.message.includes("native-process-identity-timeout"),
  );
});

test("explains an unsupported Node value with only the matrix row context", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          - host: Windows\n            os: windows-latest\n            node: 24\n",
          "          - host: Windows\n            os: windows-latest\n            node: 26\n",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "native process matrix rows are incomplete or unsupported",
      ) &&
      error.message.includes(
        "host: Windows, runner: windows-latest, Node: 26",
      ) &&
      !error.message.includes("name: Native process identity probes"),
  );
});

test("rejects a native process workflow missing a required probe", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "      - name: Verify frozen probe timeout\n        id: native-process-identity-timeout\n        run: pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-timeout\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-timeout",
      ),
  );
});

test("native workflow recovery command checks backup content and metadata after interruption", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  );
  const command = packageJson.scripts[
    "check:api-typecheck-rebuilds-libs:interrupted-publication"
  ];
  assert.equal(
    command,
    "node ./scripts/check-api-typecheck-rebuilds-db.mjs --test-interrupted-publication",
  );
  const result = spawnSync(process.execPath, command.split(" ").slice(1), {
    cwd: workspaceRoot,
    env: { ...process.env, API_TYPECHECK_INTERRUPTED_PUBLICATION_RUNS: "2" },
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const run of [1, 2]) {
    for (const shape of ["single-file", "nested-directory"]) {
      assert.ok(result.stdout.includes(
        `run ${run} of 2 restored backup content, permissions, and modification time (${shape}), preserved unrelated generated output, and released the path and transition locks.`,
      ), result.stdout);
      assert.ok(result.stdout.includes(
        `run ${run} of 2 removed unpublished staging (${shape}), preserved unrelated generated output, and released the path and transition locks.`,
      ), result.stdout);
      assert.ok(result.stdout.includes(
        `run ${run} of 2 retained newer verified content, permissions, and modification time (${shape}), preserved unrelated generated output, and released the path and transition locks.`,
      ), result.stdout);
    }
  }
});

test("requires interrupted publication recovery to run only on Windows", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "        if: ${{ matrix.os == 'windows-latest' }}\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "interrupted publication recovery probe must run only on windows-latest matrix entries",
      ),
  );
});

test("requires three isolated interrupted publication recovery runs", () => {
  for (const workflow of [
    validNativeProcessWorkflowCoverage.replace(
      '          API_TYPECHECK_INTERRUPTED_PUBLICATION_RUNS: "3"\n',
      "",
    ),
    validNativeProcessWorkflowCoverage.replace(
      '          API_TYPECHECK_INTERRUPTED_PUBLICATION_RUNS: "3"\n',
      '          API_TYPECHECK_INTERRUPTED_PUBLICATION_RUNS: "2"\n',
    ),
  ]) {
    assert.throws(
      () => checkNativeProcessWorkflowCoverage({ workflow }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "interrupted publication recovery probe must require exactly 3 isolated runs",
        ),
    );
  }
});

test("requires the Windows probe to cover the active publication boundary", () => {
  const declaration =
    '          API_TYPECHECK_INTERRUPTED_PUBLICATION_CRASH_POINTS: "staging,active,restore"\n';
  for (const replacement of [
    "",
    declaration.replace("staging,active,restore", "staging,restore"),
    declaration.replace("staging,active,restore", "active"),
    declaration + declaration,
  ]) {
    assert.throws(
      () => checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(declaration, replacement),
      }),
      /must require staging,active,restore crash points/,
    );
  }
});

test("rejects a native process workflow missing scheduled-failure diagnostics collection", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          /      - name: Collect hosted-runner diagnostics after scheduled failure[\s\S]*?      - name: Upload hosted-runner diagnostics\n/,
          "      - name: Upload hosted-runner diagnostics\n",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("scheduled-failure diagnostics collection step"),
  );
});

test("requires scheduled PID-reuse recovery record validation on successful probes", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          /      - name: Validate scheduled PID-reuse recovery record[\s\S]*?--verify-native-process-recovery-diagnostics\n/,
          "",
        ),
      }),
    /exactly one scheduled PID-reuse recovery record validation step/,
  );

  const validationStep = validNativeProcessWorkflowCoverage.match(
    /      - name: Validate scheduled PID-reuse recovery record[\s\S]*?--verify-native-process-recovery-diagnostics\n/,
  )[0];
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          validationStep,
          validationStep.replace(
            "github.event_name == 'schedule'",
            "github.event_name == 'push'",
          ),
        ),
      }),
    /must run on scheduled runs after a successful recovery probe/,
  );
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          validationStep,
          validationStep.replace(
            "native-process-diagnostics/pid-reuse-recovery-batch.json",
            "native-process-diagnostics/recovery.json",
          ),
        ),
      }),
    /must read pid-reuse-recovery-batch\.json/,
  );
});

test("rejects missing native probe failure attribution", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          /      - name: Record failed native probe before diagnostics collection[\s\S]*?--record-native-process-probe-failure\n/,
          "",
        ),
      }),
    /must record native probe failure attribution before diagnostics collection/,
  );
});

test("rejects unrecognized or unsafe native probe failure attribution", () => {
  for (const label of ["other-probe", "unsafe label"]) {
    assert.throws(
      () =>
        checkNativeProcessWorkflowCoverage({
          workflow: validNativeProcessWorkflowCoverage.replace(
            "'stale-lock-takeover'",
            `'${label}'`,
          ),
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "native probe failure attribution may contain only recognized safe labels",
        ),
    );
  }
});

test("rejects scheduled-failure attribution without the stale-lock phase output mapping", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "steps.native-process-identity.outputs.phase",
          "steps.native-process-identity.outputs.other",
        ),
      }),
    /must map the stale-lock-takeover step output to API_TYPECHECK_NATIVE_PROBE_PHASE/,
  );
});

test("rejects a missing native probe producer step id", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "        id: native-process-identity-timeout\n",
          "",
        ),
      }),
    /requires step id "native-process-identity-timeout"/,
  );
});

test("rejects a renamed native probe producer step id", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "        id: native-process-identity-timeout",
          "        id: native-process-timeout",
        ),
      }),
    /requires step id "native-process-identity-timeout"/,
  );
});

test("rejects native probe producer step ids swapped between commands", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage
          .replace(
            "        id: native-process-identity\n",
            "        id: temporary-native-process-id\n",
          )
          .replace(
            "        id: native-process-identity-timeout\n",
            "        id: native-process-identity\n",
          )
          .replace(
            "        id: temporary-native-process-id\n",
            "        id: native-process-identity-timeout\n",
          ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes('requires step id "native-process-identity"') &&
      error.message.includes(
        'requires step id "native-process-identity-timeout"',
      ),
  );
});

test("rejects native probe failure attribution after diagnostics collection", () => {
  const attributionStep =
    validNativeProcessWorkflowCoverage.match(
      /      - name: Record failed native probe before diagnostics collection[\s\S]*?--record-native-process-probe-failure\n/,
    )[0];
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage
          .replace(attributionStep, "")
          .replace(
            "      - name: Upload hosted-runner diagnostics\n",
            `${attributionStep}      - name: Upload hosted-runner diagnostics\n`,
          ),
      }),
    /must run before diagnostics collection/,
  );
});

test("rejects duplicate native probe failure attribution steps with drifted guards", () => {
  const attributionStep =
    validNativeProcessWorkflowCoverage.match(
      /      - name: Record failed native probe before diagnostics collection[\s\S]*?--record-native-process-probe-failure\n/,
    )[0];
  const duplicateAttributionStep = attributionStep.replace(
    "failure() && github.event_name == 'schedule'",
    "failure()",
  );
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "      - name: Upload hosted-runner diagnostics\n",
          `${duplicateAttributionStep}      - name: Upload hosted-runner diagnostics\n`,
        ),
      }),
    /must contain exactly one native probe failure attribution step/,
  );
});

test("rejects duplicate scheduled-failure diagnostics collection steps with drifted guards", () => {
  const collectionStep =
    validNativeProcessWorkflowCoverage.match(
      /      - name: Collect hosted-runner diagnostics after scheduled failure[\s\S]*?--collect-native-process-diagnostics\n/,
    )[0];
  const duplicateCollectionStep = collectionStep.replace(
    "failure() && github.event_name == 'schedule'",
    "failure()",
  );
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: `${validNativeProcessWorkflowCoverage}${duplicateCollectionStep}`,
      }),
    /must contain exactly one scheduled-failure diagnostics collection step/,
  );
});

test("verifies native diagnostics attribution metadata filename and field", () => {
  const collector = `
    const nativeProcessRecoveryFailureLabel = "pid-reuse-recovery-batch";
    const nativeProcessRecoveryDiagnosticsFileName =
      "pid-reuse-recovery-batch.json";
    const diagnostic = {
      failureLabel: nativeProcessRecoveryFailureLabel,
      host: {},
      runtime: {},
      affectedTransactions: [
        {
          directory: transactionDirectory,
          paths: [source],
        },
      ],
    };
    await writeDiagnostic(
      "probe-attribution.json",
      JSON.stringify({
        failedStep: process.env.API_TYPECHECK_NATIVE_PROBE_FAILURE ?? "unknown",
        failedPhase: process.env.API_TYPECHECK_NATIVE_PROBE_PHASE ?? "unknown",
      }),
    );
  `;
  assert.deepEqual(
    checkNativeProcessDiagnosticsCollectorContract({ collector }),
    {
      fileName: "probe-attribution.json",
      field: "failedStep",
      phaseField: "failedPhase",
    },
  );
  assert.throws(
    () =>
      checkNativeProcessDiagnosticsCollectorContract({
        collector: collector.replace("probe-attribution.json", "probe.json"),
      }),
    /probe-attribution\.json/,
  );
  assert.throws(
    () =>
      checkNativeProcessDiagnosticsCollectorContract({
        collector: collector.replace("failedStep:", "probe:"),
      }),
    /failedStep/,
  );
  assert.throws(
    () =>
      checkNativeProcessDiagnosticsCollectorContract({
        collector: collector.replace("failedPhase:", "phase:"),
      }),
    /failedPhase/,
  );
  assert.throws(
    () =>
      checkNativeProcessDiagnosticsCollectorContract({
        collector: collector.replace(
          '"pid-reuse-recovery-batch.json"',
          '"recovery.json"',
        ),
      }),
    /pid-reuse-recovery-batch\.json/,
  );
  assert.throws(
    () =>
      checkNativeProcessDiagnosticsCollectorContract({
        collector: collector.replace(
          "failureLabel: nativeProcessRecoveryFailureLabel",
          "label: nativeProcessRecoveryFailureLabel",
        ),
      }),
    /failureLabel/,
  );
  assert.throws(
    () =>
      checkNativeProcessDiagnosticsCollectorContract({
        collector: collector.replace("paths: [source]", "paths: []"),
      }),
    /paths/,
  );
});

test("native probe attribution fails when the GitHub environment file is unavailable", async (t) => {
  const fixtureDirectory = await mkdtemp(
    path.join(os.tmpdir(), "native-unavailable-env-"),
  );
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const baseEnv = { ...process.env };
  for (const key of [
    "GITHUB_OUTPUT", "GITHUB_ENV",
    "API_TYPECHECK_NATIVE_PROBE_FAILURE", "API_TYPECHECK_NATIVE_PROBE_PHASE",
    "API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR",
  ]) delete baseEnv[key];

  // A regular file used as a parent cannot be traversed, even by elevated
  // users. Unlike chmod-based fixtures, this also fails reliably on Windows.
  const blockedParent = path.join(fixtureDirectory, "regular-file");
  const savedContents = Buffer.from("preserve this file\n");
  await writeFile(blockedParent, savedContents);
  const blockedDestination = path.join(blockedParent, "github-env");

  for (const { name, destination } of [
    { name: "absent" },
    { name: "empty", destination: "" },
    { name: "unwritable", destination: blockedDestination },
  ]) {
    await t.test(name, async () => {
      const env = {
        ...baseEnv,
        API_TYPECHECK_NATIVE_PROBE_FAILURE: "stale-lock-takeover",
        API_TYPECHECK_NATIVE_PROBE_PHASE: requiredNativeProcessProbePhases[0],
      };
      if (destination !== undefined) env.GITHUB_ENV = destination;
      const result = spawnSync(
        process.execPath,
        [recoveryDiagnosticsVerifierPath, "--record-native-process-probe-failure"],
        {
          cwd: fixtureDirectory, env, encoding: "utf8",
          timeout: 60_000, windowsHide: true,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "", "failed attribution must not report success");
      if (name === "unwritable") {
        // Node/libuv error codes vary across platforms; require an open failure
        // naming the actual destination rather than pinning one OS's code.
        assert.match(result.stderr, /(?:ENOTDIR|ENOENT|EACCES|EPERM|EISDIR).*open/);
        assert.ok(
          result.stderr.includes(blockedDestination) ||
            result.stderr.includes(blockedDestination.replaceAll("\\", "\\\\")),
          `write failure must identify the unavailable destination: ${result.stderr}`,
        );
      } else {
        assert.match(
          result.stderr,
          /Native process probe attribution requires the GitHub Actions environment file/,
        );
      }
      assert.deepEqual(await readFile(blockedParent), savedContents);
    });
  }
});

test("invalid stale-lock failure phases leave saved diagnostics context unchanged", async (t) => {
  const fixtureDirectory = await mkdtemp(
    path.join(os.tmpdir(), "native-invalid-phase-"),
  );
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const baseEnv = { ...process.env };
  for (const key of [
    "GITHUB_OUTPUT", "GITHUB_ENV",
    "API_TYPECHECK_NATIVE_PROBE_FAILURE", "API_TYPECHECK_NATIVE_PROBE_PHASE",
    "API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR",
  ]) delete baseEnv[key];
  const savedContext = Buffer.from(
    "EXISTING_CONTEXT=preserve-me\r\n" +
    "API_TYPECHECK_NATIVE_PROBE_FAILURE=stale-lock-takeover\n" +
    `API_TYPECHECK_NATIVE_PROBE_PHASE=${requiredNativeProcessProbePhases[0]}\n`,
  );

  for (const { name, phase } of [
    { name: "missing" },
    { name: "unknown", phase: "unknown" },
    {
      name: "newline-containing",
      phase: `${requiredNativeProcessProbePhases[0]}\nINJECTED_CONTEXT=unsafe`,
    },
  ]) {
    await t.test(name, async () => {
      const environmentFile = path.join(fixtureDirectory, `${name}-github-env`);
      await writeFile(environmentFile, savedContext);
      const env = {
        ...baseEnv,
        GITHUB_ENV: environmentFile,
        API_TYPECHECK_NATIVE_PROBE_FAILURE: "stale-lock-takeover",
      };
      if (phase !== undefined) env.API_TYPECHECK_NATIVE_PROBE_PHASE = phase;
      const result = spawnSync(
        process.execPath,
        [recoveryDiagnosticsVerifierPath, "--record-native-process-probe-failure"],
        {
          cwd: workspaceRoot, env, encoding: "utf8",
          timeout: 60_000, windowsHide: true,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        /Native process probe phase must be a recognized safe label/,
      );
      assert.deepEqual(await readFile(environmentFile), savedContext);
    });
  }
});

test("scheduled diagnostics preserve safe attribution through output and environment files", async (t) => {
  const fixtureDirectory = await mkdtemp(
    path.join(os.tmpdir(), "native-phase-attribution-"),
  );
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const [probeSource, workflow] = await Promise.all([
    readFile(recoveryDiagnosticsVerifierPath, "utf8"),
    readFile(
      path.join(workspaceRoot, ".github/workflows/native-process-identity.yml"),
      "utf8",
    ),
  ]);
  // Replay the real output writer and phase announcements, without running
  // platform-specific identity probes or taking shared generated-output locks.
  const emitter = probeSource.match(
    /const nativeProcessProbePhases = new Set\([\s\S]*?\n}\n(?=\nfunction runNativeDiagnosticsCommand)/,
  )?.[0];
  assert.ok(emitter, "the probe's actual phase output writer must be available");
  const nativeProbe = probeSource.split("if (testNativeProcessIdentity) {")[1]
    ?.split("if (testNativeTransitionLockOwnerExitProbe) {")[0];
  assert.ok(nativeProbe, "the stale-lock probe must be available");
  const announcements = [...nativeProbe.matchAll(
    /(?:let )?phase = "([a-z-]+)";\s*await exposeNativeProcessProbePhase\(phase\);/g,
  )];
  assert.deepEqual(
    announcements.slice(0, requiredNativeProcessProbePhases.length)
      .map((match) => match[1]),
    requiredNativeProcessProbePhases,
  );
  const workflowStep = (name) => {
    const step = workflow.split(`      - name: ${name}\n`)[1]
      ?.split("      - ")[0];
    assert.ok(step, `workflow step ${name} must exist`);
    return step;
  };
  const attributionStep = workflowStep(
    "Record failed native probe before diagnostics collection",
  );
  const collectionStep = workflowStep(
    "Collect hosted-runner diagnostics after scheduled failure",
  );
  const workflowExpression = (step, key) => {
    const expression = step.match(new RegExp(
      `${key}: >-\\s*\\$\\{\\{([\\s\\S]*?)\\}\\}`,
    ))?.[1];
    assert.ok(expression, `workflow must define ${key}`);
    return expression;
  };
  const runWorkflowCommand = (step, env, expectedStatus = 0) => {
    const command = step.match(
      /run: pnpm exec node (\.\/scripts\/\S+) (--[a-z-]+)/,
    );
    assert.ok(command, "workflow must invoke the diagnostics script");
    const result = spawnSync(
      process.execPath, [command[1], command[2]],
      {
        cwd: workspaceRoot, env, encoding: "utf8",
        timeout: 60_000, windowsHide: true,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stderr);
    return result;
  };
  // These GitHub expressions use JS-compatible &&/|| semantics. Substitute
  // step lookups explicitly so hyphenated Actions IDs remain valid in JS.
  const evaluateExpression = (expression, steps) => {
    const javascript = expression.replace(
      /steps\.([a-z-]+)\.(outcome|outputs\.phase)/g,
      (_, id, field) => `steps[${JSON.stringify(id)}].${field}`,
    );
    return Function("steps", `"use strict"; return (${javascript});`)(steps);
  };
  const baseEnv = { ...process.env };
  for (const key of [
    "GITHUB_OUTPUT", "GITHUB_ENV",
    "API_TYPECHECK_NATIVE_PROBE_FAILURE", "API_TYPECHECK_NATIVE_PROBE_PHASE",
    "API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR",
  ]) delete baseEnv[key];

  for (const [index, expectedPhase] of requiredNativeProcessProbePhases.entries()) {
    await t.test(expectedPhase, async () => {
      const phaseDirectory = path.join(fixtureDirectory, expectedPhase);
      await mkdir(phaseDirectory);
      const outputFile = path.join(phaseDirectory, "github-output");
      const environmentFile = path.join(phaseDirectory, "github-env");
      const fixture = [
        'import { writeFile } from "node:fs/promises";',
        emitter,
        ...announcements.slice(0, index + 1).map((match) => match[0]),
        `throw new Error(${JSON.stringify(`simulated failure during ${expectedPhase}`)});`,
      ].join("\n");
      const failure = spawnSync(process.execPath, ["--input-type=module", "-e", fixture], {
        env: { ...baseEnv, GITHUB_OUTPUT: outputFile },
        encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      assert.ifError(failure.error);
      assert.equal(failure.status, 1, failure.stderr);
      assert.match(failure.stderr, new RegExp(`simulated failure during ${expectedPhase}`));
      const outputLines = (await readFile(outputFile, "utf8")).trim().split("\n");
      assert.deepEqual(outputLines, requiredNativeProcessProbePhases
        .slice(0, index + 1).map((phase) => `phase=${phase}`));
      // Actions uses the final output value and imports GITHUB_ENV only into
      // subsequent steps; do not pass the attribution step's env to collection.
      const steps = Object.fromEntries(
        [...attributionStep.matchAll(/steps\.([a-z-]+)\.outcome/g)]
          .map((match) => [match[1], { outcome: "skipped" }]),
      );
      steps["native-process-identity"] = {
        outcome: "failure",
        outputs: { phase: outputLines.at(-1).slice("phase=".length) },
      };
      const attributionEnv = Object.fromEntries(
        ["API_TYPECHECK_NATIVE_PROBE_FAILURE", "API_TYPECHECK_NATIVE_PROBE_PHASE"]
          .map((key) => [key, evaluateExpression(workflowExpression(attributionStep, key), steps)]),
      );
      assert.deepEqual(attributionEnv, {
        API_TYPECHECK_NATIVE_PROBE_FAILURE: "stale-lock-takeover",
        API_TYPECHECK_NATIVE_PROBE_PHASE: expectedPhase,
      });
      runWorkflowCommand(attributionStep, {
        ...baseEnv, ...attributionEnv, GITHUB_ENV: environmentFile,
      });
      const recordedEnvironment = await readFile(environmentFile, "utf8");
      assert.equal(recordedEnvironment,
        `API_TYPECHECK_NATIVE_PROBE_FAILURE=stale-lock-takeover\nAPI_TYPECHECK_NATIVE_PROBE_PHASE=${expectedPhase}\n`);
      const nextStepEnv = Object.fromEntries(recordedEnvironment.trim()
        .split("\n").map((line) => line.split("=")));
      const diagnosticsTemplate = collectionStep.match(
        /API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR: (.+)/,
      )?.[1];
      assert.ok(diagnosticsTemplate, "collection must configure its destination");
      const diagnosticsDirectory = diagnosticsTemplate.replace(
        "${{ runner.temp }}", phaseDirectory,
      );
      runWorkflowCommand(collectionStep, {
        ...baseEnv, ...nextStepEnv,
        API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR: diagnosticsDirectory,
      });
      assert.deepEqual(JSON.parse(await readFile(
        path.join(diagnosticsDirectory, "probe-attribution.json"), "utf8",
      )), { failedStep: "stale-lock-takeover", failedPhase: expectedPhase });
    });
  }

  const collectAttribution = async (directory, attributionEnv = {}) => {
    const diagnosticsDirectory = path.join(directory, "diagnostics");
    runWorkflowCommand(collectionStep, {
      ...baseEnv, ...attributionEnv,
      API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR: diagnosticsDirectory,
    });
    return JSON.parse(await readFile(
      path.join(diagnosticsDirectory, "probe-attribution.json"), "utf8",
    ));
  };
  const evaluateAttribution = (steps) => Object.fromEntries(
    ["API_TYPECHECK_NATIVE_PROBE_FAILURE", "API_TYPECHECK_NATIVE_PROBE_PHASE"]
      .map((key) => [key, evaluateExpression(workflowExpression(attributionStep, key), steps)]),
  );
  const absentStepMetadata = () => Object.fromEntries(
    [...attributionStep.matchAll(/steps\.([a-z-]+)\.outcome/g)]
      .map((match) => [match[1], { outcome: "", outputs: {} }]),
  );
  const recordAndCollect = async (
    directory, attributionEnv,
    expectedPhase = attributionEnv.API_TYPECHECK_NATIVE_PROBE_PHASE,
  ) => {
    await mkdir(directory);
    const environmentFile = path.join(directory, "github-env");
    runWorkflowCommand(attributionStep, {
      ...baseEnv, ...attributionEnv, GITHUB_ENV: environmentFile,
    });
    const recordedEnvironment = await readFile(environmentFile, "utf8");
    assert.equal(recordedEnvironment,
      `API_TYPECHECK_NATIVE_PROBE_FAILURE=${attributionEnv.API_TYPECHECK_NATIVE_PROBE_FAILURE}\nAPI_TYPECHECK_NATIVE_PROBE_PHASE=${expectedPhase}\n`);
    // As in Actions, only the successfully written environment is imported.
    return collectAttribution(directory, Object.fromEntries(recordedEnvironment
      .trim().split("\n").map((line) => line.split("="))));
  };

  await t.test("missing output and environment metadata is explicitly unknown", async () => {
    assert.deepEqual(await collectAttribution(
      path.join(fixtureDirectory, "absent-environment"),
    ), { failedStep: "unknown", failedPhase: "unknown" });

    const attributionEnv = evaluateAttribution(absentStepMetadata());
    assert.deepEqual(attributionEnv, {
      API_TYPECHECK_NATIVE_PROBE_FAILURE: "unknown",
      API_TYPECHECK_NATIVE_PROBE_PHASE: "not-applicable",
    });
    assert.deepEqual(await recordAndCollect(
      path.join(fixtureDirectory, "absent-step-metadata"), attributionEnv,
    ), { failedStep: "unknown", failedPhase: "not-applicable" });
  });

  await t.test("a non-stale-lock failure without phase metadata is not-applicable", async () => {
    const steps = absentStepMetadata();
    steps["native-process-identity-timeout"].outcome = "failure";
    const attributionEnv = evaluateAttribution(steps);
    assert.deepEqual(attributionEnv, {
      API_TYPECHECK_NATIVE_PROBE_FAILURE: "frozen-probe-timeout",
      API_TYPECHECK_NATIVE_PROBE_PHASE: "not-applicable",
    });
    // Omit the phase entirely to exercise the recorder's runtime fallback too.
    assert.deepEqual(await recordAndCollect(
      path.join(fixtureDirectory, "non-stale-lock"),
      { API_TYPECHECK_NATIVE_PROBE_FAILURE: "frozen-probe-timeout" },
      "not-applicable",
    ), { failedStep: "frozen-probe-timeout", failedPhase: "not-applicable" });
  });

  for (const [stepId, failedStep] of [
    ["native-process-identity-timeout", "frozen-probe-timeout"],
    ["native-process-identity-recovery", "pid-reuse-recovery-batch"],
  ]) {
    await t.test(`${failedStep} discards an old stale-lock phase`, async () => {
      const oldPhase = requiredNativeProcessProbePhases.at(-1);
      const steps = absentStepMetadata();
      steps["native-process-identity"] = {
        outcome: "success", outputs: { phase: oldPhase },
      };
      steps[stepId].outcome = "failure";
      const attributionEnv = evaluateAttribution(steps);
      assert.deepEqual(attributionEnv, {
        API_TYPECHECK_NATIVE_PROBE_FAILURE: failedStep,
        API_TYPECHECK_NATIVE_PROBE_PHASE: "not-applicable",
      });
      const expected = { failedStep, failedPhase: "not-applicable" };
      // The real workflow expression must ignore a successful earlier probe's
      // phase output, even when the job environment still has that phase.
      assert.deepEqual(await recordAndCollect(
        path.join(fixtureDirectory, `${failedStep}-workflow`),
        { API_TYPECHECK_NATIVE_PROBE_PHASE: oldPhase, ...attributionEnv },
      ), expected);
      // Independently exercise the recorder's protection if an old phase is
      // passed directly, rather than already cleared by the workflow.
      assert.deepEqual(await recordAndCollect(
        path.join(fixtureDirectory, `${failedStep}-runtime`),
        { ...attributionEnv, API_TYPECHECK_NATIVE_PROBE_PHASE: oldPhase },
        "not-applicable",
      ), expected);
    });
  }

  await t.test("unsafe or absent failure labels never create saved context", async (t) => {
    for (const { name, label } of [
      { name: "embedded whitespace", label: "unsafe label" },
      { name: "whitespace only", label: " \t " },
      { name: "environment injection", label: "safe-label\nINJECTED_CONTEXT=unsafe" },
      { name: "empty", label: "" },
      { name: "absent" },
    ]) {
      await t.test(name, async () => {
        const directory = await mkdtemp(path.join(fixtureDirectory, "unsafe-label-"));
        const environmentFile = path.join(directory, "github-env");
        const env = { ...baseEnv, GITHUB_ENV: environmentFile };
        // Keep absent distinct from empty, even when the parent has attribution.
        delete env.API_TYPECHECK_NATIVE_PROBE_FAILURE;
        if (label !== undefined) env.API_TYPECHECK_NATIVE_PROBE_FAILURE = label;
        const result = runWorkflowCommand(attributionStep, env, 1);
        assert.match(result.stderr,
          /Native process probe attribution must be a safe label/);
        await assert.rejects(readFile(environmentFile, "utf8"), { code: "ENOENT" });
      });
    }
  });

  await t.test("unsafe stale-lock phases never reach diagnostics", async (t) => {
    for (const [index, phase] of [
      "unsafe phase", "arbitrary-phase", "identity\nINJECTED=value",
    ].entries()) {
      await t.test(JSON.stringify(phase), async () => {
        const directory = path.join(fixtureDirectory, `unsafe-phase-${index}`);
        await mkdir(directory);
        const environmentFile = path.join(directory, "github-env");
        const steps = absentStepMetadata();
        steps["native-process-identity"] = {
          outcome: "failure", outputs: { phase },
        };
        const result = runWorkflowCommand(attributionStep, {
          ...baseEnv, ...evaluateAttribution(steps), GITHUB_ENV: environmentFile,
        }, 1);
        assert.match(result.stderr,
          /Native process probe phase must be a recognized safe label/);
        await assert.rejects(readFile(environmentFile, "utf8"), { code: "ENOENT" });
        // continue-on-error allows collection, but rejected metadata cannot
        // cross into its environment and must not appear in the artifact.
        assert.deepEqual(await collectAttribution(directory),
          { failedStep: "unknown", failedPhase: "unknown" });
      });
    }
  });
});

test("validates hosted PID-reuse recovery records and reports missing or malformed data", async (t) => {
  const fixtureDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pid-reuse-recovery-record-"),
  );
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));

  const diagnosticsPath = path.join(
    fixtureDirectory,
    "pid-reuse-recovery-batch.json",
  );
  const transactionDirectory = path.join(fixtureDirectory, "transaction-a");
  const generatedPath = path.join(fixtureDirectory, "generated", "api.d.ts");
  const completeRecord = {
    schemaVersion: 1,
    failureLabel: "pid-reuse-recovery-batch",
    error: "Refusing to recover a batch with reused owner PIDs",
    host: {
      name: process.env.API_TYPECHECK_NATIVE_TEST_HOST ?? process.platform,
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
    },
    runtime: {
      execPath: process.execPath,
      version: process.version,
      versions: process.versions,
    },
    affectedTransactions: [
      { directory: transactionDirectory, paths: [generatedPath] },
      {
        directory: path.join(fixtureDirectory, "transaction-b"),
        paths: [path.join(fixtureDirectory, "generated", "client.d.ts")],
      },
    ],
  };

  await writeFile(diagnosticsPath, JSON.stringify(completeRecord));
  const validResult = runRecoveryDiagnosticsVerifier(diagnosticsPath);
  assert.equal(validResult.status, 0, validResult.stderr);
  assert.match(validResult.stdout, /Validated PID-reuse recovery record/);
  assert.match(validResult.stdout, /2 affected transaction/);

  for (const schemaVersion of [undefined, 0, 2, "1", null, true, {}, []]) {
    await t.test(`rejects schemaVersion ${JSON.stringify(schemaVersion)}`, async () => {
      // JSON serialization omits undefined, exercising an unversioned record.
      await writeFile(
        diagnosticsPath,
        JSON.stringify({ ...completeRecord, schemaVersion }),
      );
      const result = runRecoveryDiagnosticsVerifier(diagnosticsPath);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(diagnosticsPath));
      assert.match(
        result.stderr,
        schemaVersion === undefined ? /Missing schemaVersion/ : /Unsupported schemaVersion/,
      );
      assert.match(result.stderr, /supported schemaVersion is 1/);
      assert.match(result.stderr, /Regenerate the record.*same revision/);
      assert.doesNotMatch(result.stdout, /Validated PID-reuse recovery record/);
    });
  }

  const missingPath = path.join(fixtureDirectory, "missing.json");
  const missingResult = runRecoveryDiagnosticsVerifier(missingPath);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /Missing PID-reuse recovery record/);
  assert.match(
    missingResult.stderr,
    /must write pid-reuse-recovery-batch\.json/,
  );

  await writeFile(diagnosticsPath, "{ this is not json");
  const malformedResult = runRecoveryDiagnosticsVerifier(diagnosticsPath);
  assert.notEqual(malformedResult.status, 0);
  assert.match(malformedResult.stderr, /is not valid JSON/);

  await writeFile(
    diagnosticsPath,
    JSON.stringify({
      ...completeRecord,
      failureLabel: "unexpected-label",
      affectedTransactions: [{ directory: transactionDirectory, paths: [] }],
      runtime: { execPath: process.execPath },
    }),
  );
  const incompleteResult = runRecoveryDiagnosticsVerifier(diagnosticsPath);
  assert.notEqual(incompleteResult.status, 0);
  assert.match(incompleteResult.stderr, /Incomplete PID-reuse recovery record/);
  assert.match(incompleteResult.stderr, /failureLabel must be/);
  assert.match(incompleteResult.stderr, /affectedTransactions\[0\]\.paths/);
  assert.match(incompleteResult.stderr, /runtime\.version/);

  await writeFile(
    diagnosticsPath,
    JSON.stringify({
      ...completeRecord,
      host: { ...completeRecord.host, platform: "not-the-current-runner" },
    }),
  );
  const mismatchedHostResult = runRecoveryDiagnosticsVerifier(diagnosticsPath);
  assert.notEqual(mismatchedHostResult.status, 0);
  assert.match(mismatchedHostResult.stderr, /host\.platform does not match/);

  await writeFile(
    diagnosticsPath,
    JSON.stringify({
      ...completeRecord,
      runtime: {
        ...completeRecord.runtime,
        versions: { ...completeRecord.runtime.versions, node: "0.0.0" },
      },
    }),
  );
  const mismatchedRuntimeResult =
    runRecoveryDiagnosticsVerifier(diagnosticsPath);
  assert.notEqual(mismatchedRuntimeResult.status, 0);
  assert.match(
    mismatchedRuntimeResult.stderr,
    /runtime\.versions\.node does not match/,
  );
});

test("rejects scheduled-failure diagnostics collection without best-effort handling", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "      - name: Collect hosted-runner diagnostics after scheduled failure\n        if: ${{ failure() && github.event_name == 'schedule' }}\n        continue-on-error: true",
          "      - name: Collect hosted-runner diagnostics after scheduled failure\n        if: ${{ failure() && github.event_name == 'schedule' }}\n        continue-on-error: false",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("collection must set continue-on-error: true"),
  );
});

test("rejects scheduled-failure diagnostics when its failure guard drifts", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "      - name: Collect hosted-runner diagnostics after scheduled failure\n        if: ${{ failure() && github.event_name == 'schedule' }}",
          "      - name: Collect hosted-runner diagnostics after scheduled failure\n        if: ${{ failure() }}",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "scheduled-failure diagnostics collection must run only when",
      ),
  );
});

test("rejects scheduled-failure diagnostics upload when its failure guard drifts", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "      - name: Upload hosted-runner diagnostics\n        if: ${{ failure() && github.event_name == 'schedule' }}",
          "      - name: Upload hosted-runner diagnostics\n        if: ${{ failure() }}",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "scheduled-failure diagnostics upload must run only when",
      ),
  );
});

test("rejects scheduled-failure diagnostics artifact names without the matrix operating system", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "-${{ matrix.os }}",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "scheduled-failure diagnostics artifact name must include matrix.os",
      ),
  );
});

test("rejects scheduled-failure diagnostics artifact names without the matrix Node version", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "-${{ matrix.node }}",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "scheduled-failure diagnostics artifact name must include matrix.node",
      ),
  );
});

test("rejects colliding scheduled-failure diagnostics artifact names with matrix dimensions", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "-${{ matrix.node }}",
          "-${{ matrix.node == 22 && 'same' || 'same' }}",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "scheduled-failure diagnostics artifact names must be unique",
      ) &&
      error.message.includes(
        "host: macOS, runner: macos-latest, Node: 22",
      ) &&
      error.message.includes(
        "host: macOS, runner: macos-latest, Node: 24",
      ),
  );
});

test("rejects a native process workflow missing the diagnostics upload", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          /      - name: Upload hosted-runner diagnostics[\s\S]*?          retention-days: 14\n/,
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "upload-artifact step for scheduled-failure diagnostics",
      ),
  );
});

test("requires scheduled diagnostics uploads to include the recovery record directory", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          path: \${{ runner.temp }}/native-process-diagnostics",
          "          path: \${{ runner.temp }}/other-diagnostics",
        ),
      }),
    /upload path must include the PID-reuse recovery record directory/,
  );
});

test("rejects a diagnostics upload that does not ignore an empty path", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          if-no-files-found: ignore",
          "          if-no-files-found: error",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("upload must set if-no-files-found: ignore"),
  );
});

test("rejects scheduled-failure diagnostics upload without retention-days", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          retention-days: 14\n",
          "",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "scheduled-failure diagnostics upload must set an explicit retention-days value",
      ),
  );
});

test("rejects scheduled-failure diagnostics upload with a non-numeric retention period", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowCoverage({
        workflow: validNativeProcessWorkflowCoverage.replace(
          "          retention-days: 14",
          "          retention-days: fourteen",
        ),
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "scheduled-failure diagnostics upload retention-days must be a finite positive integer",
      ),
  );
});

test("accepts quoted trigger keys and flow-style schedule entries", () => {
  assert.deepEqual(
    checkNativeProcessWorkflowContract({
      workflows: {
        "native-process-identity.yml": validAlternateNativeProcessWorkflow,
        "frontend-typecheck-refresh.yml": "on:\n  workflow_dispatch:\n",
      },
    }),
    {
      workflow: "native-process-identity.yml",
      scheduledWorkflows: ["native-process-identity.yml"],
      scheduleEntries: 1,
    },
  );
});

test("accepts a compact flow-style trigger mapping", () => {
  assert.deepEqual(
    checkNativeProcessWorkflowContract({
      workflows: {
        "native-process-identity.yml": validCompactNativeProcessWorkflow,
        "frontend-typecheck-refresh.yml": "on:\n  workflow_dispatch:\n",
      },
    }),
    {
      workflow: "native-process-identity.yml",
      scheduledWorkflows: ["native-process-identity.yml"],
      scheduleEntries: 1,
    },
  );
});

test("rejects a newly added scheduled artifact upload without retention-days", () => {
  const workflowWithAdditionalUpload = `${validNativeProcessWorkflow}    steps:
      - name: Upload additional scheduled artifact
        uses: actions/upload-artifact@v4
        with:
          name: additional-diagnostics
          path: diagnostics
`;

  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": workflowWithAdditionalUpload,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        ".github/workflows/native-process-identity.yml Upload additional scheduled artifact scheduled artifact upload must set an explicit retention-days value",
      ),
  );
});

test("rejects a newly added scheduled artifact upload with an invalid retention-days value", () => {
  const workflowWithAdditionalUpload = `${validNativeProcessWorkflow}    steps:
      - name: Upload additional scheduled artifact
        uses: actions/upload-artifact@v4
        with:
          name: additional-diagnostics
          path: diagnostics
          retention-days: 0
`;

  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": workflowWithAdditionalUpload,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        ".github/workflows/native-process-identity.yml Upload additional scheduled artifact scheduled artifact upload retention-days must be a finite positive integer",
      ),
  );
});

test("rejects a malformed flow-style trigger map instead of hiding the schedule", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml":
            validCompactNativeProcessWorkflow.replace(
              "'on': { 'pull_request': {}, 'push': { 'branches': ['main'] }, 'schedule': [{ 'cron': '17 4 * * 1' }], 'workflow_dispatch': {} }",
              "'on': { 'pull_request': {}, 'push': { 'branches': ['main'] }, 'schedule': [{ 'cron': '17 4 * * 1' }], 'workflow_dispatch': {}",
            ),
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        ".github/workflows/native-process-identity.yml has invalid trigger syntax",
      ) &&
      error.message.includes(
        'flow-style trigger value "on: { \'pull_request\': {}, \'push\': { \'branches\': [\'main\'] }, \'schedule\': [{ \'cron\': \'17 4 * * 1\' }], \'workflow_dispatch\': {}"',
      ) &&
      error.message.includes("unterminated flow-style map or list"),
  );
});

test("rejects a malformed flow-style trigger list instead of hiding the schedule", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": validCompactNativeProcessWorkflow.replace(
            "'on': { 'pull_request': {}, 'push': { 'branches': ['main'] }, 'schedule': [{ 'cron': '17 4 * * 1' }], 'workflow_dispatch': {} }",
            "'on': ['pull_request', { 'schedule': [{ 'cron': '17 4 * * 1' }] }]",
          ),
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        ".github/workflows/native-process-identity.yml has invalid trigger syntax",
      ) &&
      error.message.includes(
        "flow-style trigger value \"on: ['pull_request', { 'schedule': [{ 'cron': '17 4 * * 1' }] }]\"",
      ) &&
      error.message.includes(
        "trigger lists must contain only event names",
      ),
  );
});

test("reports every malformed workflow trigger in one explicit contract failure", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml":
            validCompactNativeProcessWorkflow.replace(
              "'on': { 'pull_request': {}, 'push': { 'branches': ['main'] }, 'schedule': [{ 'cron': '17 4 * * 1' }], 'workflow_dispatch': {} }",
              "'on': { 'pull_request': {}, 'push': { 'branches': ['main'] }, 'schedule': [{ 'cron': '17 4 * * 1' }], 'workflow_dispatch': {}",
            ),
          "unrelated-malformed-trigger.yml":
            "on: ['push', { 'schedule': [{ 'cron': '17 4 * * 2' }] }]\\n",
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.startsWith(
        "The native process workflow trigger contract has drifted.",
      ) &&
      error.message.includes(
        "Workflow: .github/workflows/native-process-identity.yml",
      ) &&
      error.message.includes(
        ".github/workflows/native-process-identity.yml has invalid trigger syntax",
      ) &&
      error.message.includes(
        ".github/workflows/unrelated-malformed-trigger.yml has invalid trigger syntax",
      ),
  );
});

test("rejects multiline trigger values with their unsupported representation", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": validNativeProcessWorkflow.replace(
            "on:\n  pull_request:",
            "on: |\n  pull_request:",
          ),
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        ".github/workflows/native-process-identity.yml has invalid trigger syntax",
      ) &&
      error.message.includes('multiline trigger value "on: |"') &&
      error.message.includes("multiline trigger values are not supported"),
  );
});

test("rejects a missing flow-style recurring schedule", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml":
            validAlternateNativeProcessWorkflow.replace(
              "  'schedule': [{ 'cron': '17 4 * * 1' }]\n",
              "",
            ),
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "exactly one recurring schedule trigger (found 0)",
      ),
  );
});

test("rejects a native process workflow missing a required trigger", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": validNativeProcessWorkflow.replace(
            "  pull_request:\n",
            "",
          ),
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("exactly one pull_request trigger"),
  );
});

test("rejects a native process workflow that does not push from main", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": validNativeProcessWorkflow.replace(
            "      - main",
            "      - develop",
          ),
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("push trigger for the main branch"),
  );
});

test("rejects duplicate recurring schedule entries", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": validNativeProcessWorkflow.replace(
            '    - cron: "17 4 * * 1"',
            '    - cron: "17 4 * * 1"\n    - cron: "17 4 * * 2"',
          ),
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "exactly one recurring schedule trigger (found 2)",
      ),
  );
});

test("rejects duplicate flow-style recurring schedule entries", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml":
            validAlternateNativeProcessWorkflow.replace(
              "[{ 'cron': '17 4 * * 1' }]",
              "[{ 'cron': '17 4 * * 1' }, { 'cron': '17 4 * * 2' }]",
            ),
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "exactly one recurring schedule trigger (found 2)",
      ),
  );
});

test("rejects a schedule moved into a second workflow", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": validNativeProcessWorkflow,
          "second-native-process.yml": `
on:
  schedule:
    - cron: "17 4 * * 1"
`,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("scheduled workflows may only be") &&
      error.message.includes(".github/workflows/second-native-process.yml"),
  );
});

test("rejects a flow-style schedule moved into a second workflow", () => {
  assert.throws(
    () =>
      checkNativeProcessWorkflowContract({
        workflows: {
          "native-process-identity.yml": validAlternateNativeProcessWorkflow,
          "second-native-process.yml": `
'on':
  'schedule': [{ 'cron': '17 4 * * 1' }]
`,
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("scheduled workflows may only be") &&
      error.message.includes(".github/workflows/second-native-process.yml"),
  );
});
