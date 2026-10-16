import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  compareRequiredStatusContexts,
  extractRulesetMergeRequirements,
  formatMergeCheckAuditFailure,
  inspectWorkflowDefinitions,
  readApplicableRulesetRules,
  readRepositoryId,
  readRequiredStatusContexts,
} from "./check-required-merge-checks.mjs";

const branchProtectionResponseFixtures = Object.freeze({
  legacyRequiredStatusContexts: Object.freeze({
    status: 200,
    body: Object.freeze({
      required_status_checks: Object.freeze({
        strict: true,
        contexts: Object.freeze([
          "Frontend API type refresh / Refresh API client declarations during frontend typecheck",
          "Native process identity probes / macOS Node.js 22 identity probe",
        ]),
      }),
    }),
  }),
  modernRequiredStatusChecks: Object.freeze({
    status: 200,
    body: Object.freeze({
      required_status_checks: Object.freeze({
        strict: true,
        contexts: Object.freeze([]),
        checks: Object.freeze([
          Object.freeze({
            context:
              "Frontend API type refresh / Refresh API client declarations during frontend typecheck",
            app_id: 15368,
          }),
          Object.freeze({
            context:
              "Native process identity probes / macOS Node.js 22 identity probe",
            app_id: 15368,
          }),
        ]),
      }),
    }),
  }),
  unprotectedBranch: Object.freeze({
    status: 404,
    body: Object.freeze({ message: "Branch not protected" }),
  }),
  insufficientPermissions: Object.freeze({
    status: 403,
    body: Object.freeze({
      message:
        "Resource not accessible by integration; token=ghs_fixture_secret_token; credential=fixture_private_credential",
    }),
  }),
  invalidToken: Object.freeze({
    status: 401,
    body: Object.freeze({ message: "Bad credentials" }),
  }),
});

const executeFile = promisify(execFile);
// Deliberately independent of the comparison helper: exercise the actual CLI
// against the checked-in workflow contracts, not a mocked import or fetch.
const cliExpectedContexts = [
  "Frontend API type refresh / Refresh API client declarations during frontend typecheck",
  "Native process identity probes / macOS Node.js 22 identity probe",
  "Native process identity probes / macOS Node.js 24 identity probe",
  "Native process identity probes / Windows Node.js 22 identity probe",
  "Native process identity probes / Windows Node.js 24 identity probe",
];

async function runAuditCli(t, protection, {
  rules = [],
  repositoryMetadata,
  rulesResponse,
  repositoryResponse,
} = {}) {
  const requests = [];
  const protectionPath = "/repos/fixture-owner/fixture-repo/branches/main/protection";
  const rulesPath = "/repos/fixture-owner/fixture-repo/rules/branches/main?per_page=100&page=1";
  const repositoryPath = "/repos/fixture-owner/fixture-repo";
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
    });
    const fixture = request.url === protectionPath
      ? protection
      : request.url === rulesPath
        ? rulesResponse ?? { status: 200, body: rules }
        : request.url === repositoryPath && repositoryMetadata
          ? repositoryResponse ?? { status: 200, body: repositoryMetadata }
          : { status: 500, body: { message: "Unexpected fixture request" } };
    if (fixture.disconnect) {
      request.socket.destroy();
      return;
    }
    response.writeHead(fixture.status, { "Content-Type": "application/json" });
    response.end(fixture.rawBody ?? JSON.stringify(fixture.body));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  // Do not inherit credentials, Node preload flags, proxies, or GitHub settings
  // from the developer/Actions environment. Every HTTP call targets loopback.
  const env = {
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_REPOSITORY: "fixture-owner/fixture-repo",
    ...(repositoryMetadata ? {} : { GITHUB_REPOSITORY_ID: "123" }),
    GITHUB_BRANCH: "main",
    GITHUB_TOKEN: "ghs_fixture_secret_token",
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  let result;
  try {
    result = {
      ...await executeFile(process.execPath, [
        fileURLToPath(new URL("./check-required-merge-checks.mjs", import.meta.url)),
      ], { env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }),
      code: 0,
    };
  } catch (error) {
    assert.equal(error.killed, false, "audit must exit without timing out");
    assert.equal(error.signal, null, "audit must exit normally");
    assert.equal(typeof error.code, "number", "audit process must start successfully");
    result = error;
  }
  assert.deepEqual(
    requests.map((request) => request.url).sort(),
    [protectionPath, rulesPath, ...(repositoryMetadata ? [repositoryPath] : [])].sort(),
    "the real CLI must read protection, applicable rules, and repository metadata only when needed",
  );
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.authorization, "Bearer ghs_fixture_secret_token");
  }
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /ghs_fixture_secret_token|fixture_private_credential/,
  );
  return result;
}

const matchingProtectionResponse = {
  status: 200,
  body: { required_status_checks: { contexts: cliExpectedContexts } },
};
const matchingStatusRules = [{
  type: "required_status_checks",
  parameters: {
    required_status_checks: cliExpectedContexts.map((context) => ({ context })),
  },
}];
const matchingWorkflowRules = [{
  type: "workflows",
  parameters: {
    workflows: [{
      path: ".github/workflows/native-process-identity.yml",
      repository_id: 123,
      ref: "refs/heads/main",
    }],
  },
}];

for (const endpoint of ["protection", "rules", "repository"]) {
  for (const malformed of [
    { name: "empty body", rawBody: "" },
    {
      name: "truncated JSON",
      rawBody: '{"message":"ghs_fixture_secret_token fixture_private_credential"',
    },
  ]) {
    test(`CLI rejects HTTP 200 ${malformed.name} from ${endpoint}`, { timeout: 15_000 }, async (t) => {
      const brokenResponse = { status: 200, rawBody: malformed.rawBody };
      const result = await runAuditCli(t,
        endpoint === "protection" ? brokenResponse : matchingProtectionResponse,
        {
          // Otherwise-sufficient protection proves an unreadable response
          // cannot be mistaken for empty protection and silently pass.
          rules: endpoint === "repository" ? matchingWorkflowRules : matchingStatusRules,
          ...(endpoint === "rules" ? { rulesResponse: brokenResponse } : {}),
          ...(endpoint === "repository" ? {
            repositoryMetadata: { id: 123 },
            repositoryResponse: brokenResponse,
          } : {}),
        },
      );
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      const diagnostic = {
        protection: /GitHub branch-protection request returned an unexpected response.*expected.*JSON/i,
        rules: /GitHub branch-rules request returned an unexpected response; expected an array/,
        repository: /GitHub repository-metadata request returned an unexpected response; expected a numeric repository ID/,
      }[endpoint];
      assert.match(result.stderr, diagnostic);
      assert.doesNotMatch(result.stdout + result.stderr, /match \d+ intended workflow context/);
    });
  }
}

test("CLI fails promptly when the branch-rules connection closes without a response", { timeout: 15_000 }, async (t) => {
  const result = await runAuditCli(t, matchingProtectionResponse, {
    rulesResponse: { disconnect: true },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /fetch failed/i);
  assert.doesNotMatch(result.stdout + result.stderr, /match \d+ intended workflow context/);
});

for (const scenario of [
  { name: "matching protection", missing: false, extra: false },
  { name: "a missing check", missing: true, extra: false },
  { name: "an extra check", missing: false, extra: true },
  { name: "missing and extra checks", missing: true, extra: true },
]) {
  test(`CLI exits and reports correctly for ${scenario.name}`, async (t) => {
    const contexts = scenario.missing
      ? cliExpectedContexts.slice(1)
      : [...cliExpectedContexts];
    if (scenario.extra) contexts.push("obsolete fixture check");
    const result = await runAuditCli(t, {
      status: 200,
      body: { required_status_checks: { contexts } },
    });
    if (!scenario.missing && !scenario.extra) {
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.equal(
        result.stdout.trim(),
        "Required merge checks for fixture-owner/fixture-repo#main match 5 intended workflow context(s); found 0 applicable active ruleset(s).",
      );
      return;
    }
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Protected branch: main/);
    if (scenario.missing) {
      assert.ok(result.stderr.includes(`Missing required checks:\n- ${cliExpectedContexts[0]}`));
    } else {
      assert.doesNotMatch(result.stderr, /Missing required checks:/);
    }
    if (scenario.extra) {
      assert.match(result.stderr, /Extra required checks:\n- obsolete fixture check/);
    } else {
      assert.doesNotMatch(result.stderr, /Extra required checks:/);
    }
    assert.doesNotMatch(result.stderr, /match \d+ intended workflow context/);
  });
}

for (const useWorkflowRule of [false, true]) {
  test(`CLI accepts ruleset-only protection using ${useWorkflowRule ? "status and workflow rules with repository lookup" : "status rules"}`, async (t) => {
    const rules = [{
      type: "required_status_checks",
      ruleset_id: 42,
      ruleset_source_type: "Repository",
      ruleset_source: "fixture-owner/fixture-repo",
      parameters: {
        required_status_checks: (useWorkflowRule
          ? cliExpectedContexts.slice(0, 1)
          : cliExpectedContexts).map((context) => ({ context })),
      },
    }];
    if (useWorkflowRule) {
      // The four native checks must come from this workflow rule, not status
      // contexts. A non-default ID proves metadata is used for matching.
      rules.push({
        type: "workflows",
        ruleset_id: 43,
        ruleset_source_type: "Organization",
        ruleset_source: "fixture-owner",
        parameters: {
          workflows: [{
            path: ".github/workflows/native-process-identity.yml",
            repository_id: 987,
            ref: "refs/heads/main",
          }],
        },
      });
    }
    const result = await runAuditCli(t, branchProtectionResponseFixtures.unprotectedBranch, {
      rules,
      ...(useWorkflowRule ? { repositoryMetadata: { id: 987 } } : {}),
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout.trim(),
      `Required merge checks for fixture-owner/fixture-repo#main match 5 intended workflow context(s); found ${useWorkflowRule ? 2 : 1} applicable active ruleset(s).`,
    );
  });
}

test("CLI fails with actionable, credential-safe guidance when administration access is denied", async (t) => {
  const result = await runAuditCli(t, branchProtectionResponseFixtures.insufficientPermissions);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GitHub denied access to branch protection/);
  assert.match(result.stderr, /fixture-owner\/fixture-repo/);
  assert.match(result.stderr, /Administration: read/);
  assert.doesNotMatch(result.stderr, /Missing required checks:|Extra required checks:|match \d+ intended workflow context/);
});

test("the maintenance audit runs daily and manually without becoming a PR gate", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/required-merge-checks.yml", import.meta.url),
    "utf8",
  );
  const triggers = workflow.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1];
  assert.ok(triggers, "the audit must declare its triggers");
  assert.match(triggers, /^  workflow_dispatch:\s*$/m);
  assert.match(triggers, /^  schedule:\s*$/m);
  assert.match(triggers, /^    - cron: "23 8 \* \* \*"$/m);
  assert.deepEqual(
    [...triggers.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]).sort(),
    ["schedule", "workflow_dispatch"],
    "administration-read access must not become a pull-request dependency",
  );
  assert.match(workflow, /run: pnpm run check:required-merge-checks/);
  assert.match(workflow, /GITHUB_BRANCH: main/);
  assert.match(
    workflow,
    /GITHUB_TOKEN: \$\{\{ secrets\.BRANCH_PROTECTION_AUDIT_TOKEN \|\| github\.token \}\}/,
  );
  assert.doesNotMatch(workflow, /continue-on-error: true|\|\| true/);
});

test("drift diagnostics identify the branch and missing and unexpected protection", () => {
  const comparison = compareRequiredStatusContexts({
    requiredContexts: ["obsolete check"],
    expectedContexts: ["intended check"],
    requiredWorkflowPaths: [".github/workflows/unexpected.yml"],
  });
  assert.equal(comparison.ok, false);
  const failure = formatMergeCheckAuditFailure({
    branch: "release/protected",
    comparison,
  });
  assert.match(failure, /Protected branch: release\/protected/);
  assert.match(failure, /Missing required checks:\n- intended check/);
  assert.match(failure, /Extra required checks:\n- obsolete check/);
  assert.match(
    failure,
    /Extra required workflow rules:\n- \.github\/workflows\/unexpected\.yml/,
  );
});

function fetchResponseFixture(fixture, expectedRequest) {
  return async (url, init) => {
    if (expectedRequest) {
      assert.equal(url, expectedRequest.url);
      assert.equal(init.headers.Authorization, expectedRequest.authorization);
    }
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
    });
  };
}

const refreshWorkflow = `
name: Frontend API type refresh
jobs:
  frontend-typecheck-refresh:
    name: Refresh API client declarations during frontend typecheck
    steps:
      - name: Verify generated API code is in sync
        id: api-codegen-drift
        run: pnpm run check:api-codegen-drift
`;

test("subscriber matrix feeds the stable required check and reports version-labelled failures", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/frontend-typecheck-refresh.yml", import.meta.url),
    "utf8",
  );
  const [requiredJob, subscriberJob] = workflow.split("\n  subscriber-notifications:\n");
  assert.match(requiredJob, /needs: \[subscriber-notifications, standard-recovery\]/);
  assert.match(requiredJob, /if: \$\{\{ always\(\) \}\}/);
  assert.match(requiredJob, /SUBSCRIBER_RESULT: \$\{\{ needs\.subscriber-notifications\.result \}\}/);
  assert.match(requiredJob, /RECOVERY_RESULT: \$\{\{ needs\.standard-recovery\.result \}\}/);
  const gate = requiredJob.match(/        run: \|\n([\s\S]*?)      - uses:/)?.[1];
  assert.ok(gate, "required job must check the matrix result before other steps");
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const child = spawnSync("bash", ["-c", gate], {
      env: { ...process.env, SUBSCRIBER_RESULT: result, RECOVERY_RESULT: "success" },
    });
    assert.equal(child.status, result === "success" ? 0 : 1, result);
  }
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const child = spawnSync("bash", ["-c", gate], {
      env: { ...process.env, SUBSCRIBER_RESULT: "success", RECOVERY_RESULT: result },
    });
    assert.equal(child.status, result === "success" ? 0 : 1, `recovery: ${result}`);
  }
  assert.match(subscriberJob, /name: Subscriber notifications on Node\.js \$\{\{ matrix\.node \}\}/);
  assert.match(subscriberJob, /fail-fast: false/);
  assert.match(subscriberJob, /node: \[22, 24\]/);
  assert.match(subscriberJob, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(subscriberJob, /image: postgres:16/);
  assert.match(subscriberJob, /drizzle-kit push/);
  assert.match(subscriberJob, /set -o pipefail/);
  assert.match(subscriberJob, /run test:subscriber-notifications 2>&1/);
  assert.match(subscriberJob, /steps\.subscriber-notifications\.outcome == 'failure'/);
  assert.ok(subscriberJob.includes("Node.js ${process.version}"));
  assert.ok(subscriberJob.includes('output.matchAll(/^\\s*not ok \\d+ - (.+)$/gm)'));
});

const nativeWorkflow = `
name: Native process identity probes
jobs:
  process-identity:
    name: \${{ matrix.host }} Node.js \${{ matrix.node }} identity probe
    strategy:
      matrix:
        include:
          - host: macOS
            os: macos-latest
            node: 22
          - host: macOS
            os: macos-latest
            node: 24
          - host: Windows
            os: windows-latest
            node: 22
          - host: Windows
            os: windows-latest
            node: 24
`;

test("expands intended refresh and native matrix status contexts", () => {
  const definitions = inspectWorkflowDefinitions({
    workflows: {
      "frontend-typecheck-refresh.yml": refreshWorkflow,
      "native-process-identity.yml": nativeWorkflow,
    },
  });

  assert.deepEqual(definitions.renamed, []);
  assert.deepEqual(definitions.expectedContexts, [
    "Frontend API type refresh / Refresh API client declarations during frontend typecheck",
    "Native process identity probes / macOS Node.js 22 identity probe",
    "Native process identity probes / macOS Node.js 24 identity probe",
    "Native process identity probes / Windows Node.js 22 identity probe",
    "Native process identity probes / Windows Node.js 24 identity probe",
  ]);
  assert.deepEqual(definitions.actualContexts, definitions.expectedContexts);
});

test("rejects a removed or renamed generated API freshness step with repair guidance", () => {
  for (const [change, workflow] of [
    [
      "removed",
      refreshWorkflow.replace(
        /      - name: Verify generated API code is in sync\n        id: api-codegen-drift\n        run: pnpm run check:api-codegen-drift\n/,
        "",
      ),
    ],
    [
      "renamed",
      refreshWorkflow.replace(
        "Verify generated API code is in sync",
        "Run API drift check",
      ),
    ],
    [
      "command changed",
      refreshWorkflow.replace(
        "pnpm run check:api-codegen-drift",
        "pnpm run check:api-typecheck",
      ),
    ],
  ]) {
    const definitions = inspectWorkflowDefinitions({
      workflows: {
        "frontend-typecheck-refresh.yml": workflow,
        "native-process-identity.yml": nativeWorkflow,
      },
    });
    const comparison = compareRequiredStatusContexts({
      requiredContexts: definitions.expectedContexts,
      expectedContexts: definitions.expectedContexts,
      actualWorkflowContexts: definitions.actualContexts,
      renamed: definitions.renamed,
    });
    const failure = formatMergeCheckAuditFailure({
      branch: "main",
      comparison,
    });

    assert.equal(
      comparison.ok,
      false,
      `The ${change} gate must fail the audit.`,
    );
    assert.match(failure, /generated API freshness gate/i);
    assert.match(failure, /Restore the protected generated API freshness step/);
    if (change === "renamed") {
      assert.match(failure, /Verify generated API code is in sync/);
    }
  }
});

test("the checked-in frontend refresh workflow keeps the generated API freshness gate", async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const workflow = await readFile(
    path.join(
      testDirectory,
      "..",
      ".github",
      "workflows",
      "frontend-typecheck-refresh.yml",
    ),
    "utf8",
  );
  const definitions = inspectWorkflowDefinitions({
    workflows: {
      "frontend-typecheck-refresh.yml": workflow,
      "native-process-identity.yml": nativeWorkflow,
    },
  });
  const freshnessChanges = definitions.renamed.filter(
    (change) => change.purpose === "generated API freshness",
  );

  assert.deepEqual(
    freshnessChanges,
    [],
    [
      "The generated API freshness gate is missing or changed in",
      ".github/workflows/frontend-typecheck-refresh.yml.",
      'Restore step id "api-codegen-drift", name',
      '"Verify generated API code is in sync", and command',
      '"pnpm run check:api-codegen-drift", or update the',
      "required merge-check contract intentionally.",
    ].join(" "),
  );
});

test("reports workflow and job renames separately from required-context drift", () => {
  const definitions = inspectWorkflowDefinitions({
    workflows: {
      "frontend-typecheck-refresh.yml": refreshWorkflow.replace(
        "Frontend API type refresh",
        "Renamed refresh workflow",
      ),
      "native-process-identity.yml": nativeWorkflow.replace(
        "${{ matrix.host }} Node.js ${{ matrix.node }} identity probe",
        "${{ matrix.host }} Node.js ${{ matrix.node }} renamed identity probe",
      ),
    },
  });

  assert.equal(definitions.renamed.length, 2);
  assert.deepEqual(
    definitions.renamed.map((change) => change.kind),
    ["workflow", "job"],
  );
  const comparison = compareRequiredStatusContexts({
    requiredContexts: definitions.expectedContexts,
    expectedContexts: definitions.expectedContexts,
    actualWorkflowContexts: definitions.actualContexts,
    renamed: definitions.renamed,
  });
  assert.equal(comparison.ok, false);
  assert.equal(comparison.workflowContextDrift.length, 5);
});

test("reports missing and extra protected-branch contexts", () => {
  const comparison = compareRequiredStatusContexts({
    requiredContexts: ["old refresh check", "unrelated check"],
    expectedContexts: ["intended refresh check", "intended native check"],
  });

  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.missing, [
    "intended native check",
    "intended refresh check",
  ]);
  assert.deepEqual(comparison.extra, ["old refresh check", "unrelated check"]);
});

test("accepts applicable ruleset workflows as protection for their contract checks", () => {
  const definitions = inspectWorkflowDefinitions({
    workflows: {
      "frontend-typecheck-refresh.yml": refreshWorkflow,
      "native-process-identity.yml": nativeWorkflow,
    },
  });
  const comparison = compareRequiredStatusContexts({
    requiredContexts: [
      "Native process identity probes / macOS Node.js 22 identity probe",
    ],
    requiredWorkflowRules: [
      {
        path: ".github/workflows/frontend-typecheck-refresh.yml",
        repositoryId: 123,
      },
      {
        path: ".github/workflows/native-process-identity.yml",
        repositoryId: 123,
      },
    ],
    expectedContexts: definitions.expectedContexts,
    expectedWorkflowRules: definitions.expectedWorkflowRules.map(
      (workflow) => ({ ...workflow, repositoryId: 123 }),
    ),
  });

  assert.equal(comparison.ok, true);
  assert.deepEqual(comparison.missing, []);
  assert.deepEqual(comparison.requiredWorkflows, [
    ".github/workflows/frontend-typecheck-refresh.yml (repository ID 123)",
    ".github/workflows/native-process-identity.yml (repository ID 123)",
  ]);
});

test("reports unexpected ruleset statuses and workflows", () => {
  const comparison = compareRequiredStatusContexts({
    requiredContexts: ["unexpected check"],
    requiredWorkflowPaths: [".github/workflows/unexpected.yml"],
    expectedContexts: ["expected check"],
    expectedWorkflowRules: [
      { path: ".github/workflows/expected.yml", contexts: ["expected check"] },
    ],
  });

  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.missing, ["expected check"]);
  assert.deepEqual(comparison.extra, ["unexpected check"]);
  assert.deepEqual(comparison.extraWorkflows, [
    ".github/workflows/unexpected.yml",
  ]);
});

test("does not accept a same-path required workflow from another repository", () => {
  const comparison = compareRequiredStatusContexts({
    requiredContexts: [],
    requiredWorkflowRules: [
      {
        path: ".github/workflows/expected.yml",
        repositoryId: 999,
      },
    ],
    expectedContexts: ["expected check"],
    expectedWorkflowRules: [
      {
        path: ".github/workflows/expected.yml",
        repositoryId: 123,
        contexts: ["expected check"],
      },
    ],
  });

  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.missing, ["expected check"]);
  assert.deepEqual(comparison.extraWorkflows, [
    ".github/workflows/expected.yml (repository ID 999)",
  ]);
});

test("reports a missing workflow definition without hiding the expected contexts", () => {
  const definitions = inspectWorkflowDefinitions({
    workflows: {
      "frontend-typecheck-refresh.yml": refreshWorkflow,
    },
  });

  assert.equal(
    definitions.renamed.some(
      (change) =>
        change.kind === "missing-workflow" &&
        change.workflowFile === "native-process-identity.yml",
    ),
    true,
  );
  assert.equal(definitions.expectedContexts.length, 5);
});

test("reads legacy required status contexts from a recorded GitHub response", async () => {
  const contexts = await readRequiredStatusContexts({
    apiBaseUrl: "https://api.example.test",
    repository: "owner/repo",
    branch: "main",
    token: "test-token",
    fetchImpl: fetchResponseFixture(
      branchProtectionResponseFixtures.legacyRequiredStatusContexts,
      {
        url: "https://api.example.test/repos/owner/repo/branches/main/protection",
        authorization: "Bearer test-token",
      },
    ),
  });

  assert.deepEqual(contexts, [
    "Frontend API type refresh / Refresh API client declarations during frontend typecheck",
    "Native process identity probes / macOS Node.js 22 identity probe",
  ]);
});

test("reads modern required check objects from a recorded GitHub response", async () => {
  const contexts = await readRequiredStatusContexts({
    apiBaseUrl: "https://api.example.test",
    repository: "owner/repo",
    branch: "main",
    token: "test-token",
    fetchImpl: fetchResponseFixture(
      branchProtectionResponseFixtures.modernRequiredStatusChecks,
    ),
  });

  assert.deepEqual(contexts, [
    "Frontend API type refresh / Refresh API client declarations during frontend typecheck",
    "Native process identity probes / macOS Node.js 22 identity probe",
  ]);
});

test("reports missing required checks when branch protection is absent", async () => {
  const requiredContexts = await readRequiredStatusContexts({
    apiBaseUrl: "https://api.example.test",
    repository: "owner/repo",
    branch: "main",
    token: "test-token",
    fetchImpl: fetchResponseFixture(
      branchProtectionResponseFixtures.unprotectedBranch,
    ),
  });
  const comparison = compareRequiredStatusContexts({
    requiredContexts,
    expectedContexts: ["expected required check"],
  });
  const failure = formatMergeCheckAuditFailure({ branch: "main", comparison });

  assert.match(failure, /Missing required checks:\n- expected required check/);
  assert.match(failure, /Protected branch currently requires:\n- \(none\)/);
});

test("reports missing permissions without exposing response credentials", async () => {
  const token = "ghs_fixture_secret_token";
  let failure;
  try {
    await readRequiredStatusContexts({
      apiBaseUrl: "https://api.example.test",
      repository: "owner/repo",
      branch: "main",
      token,
      fetchImpl: fetchResponseFixture(
        branchProtectionResponseFixtures.insufficientPermissions,
      ),
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.match(failure.message, /HTTP|denied access/i);
  assert.match(failure.message, /Administration: read/);
  assert.doesNotMatch(
    failure.message,
    /ghs_fixture_secret_token|fixture_private_credential/,
  );
});

test("explains how to fix an invalid or expired GitHub token", async () => {
  await assert.rejects(
    readRequiredStatusContexts({
      apiBaseUrl: "https://api.example.test",
      repository: "owner/repo",
      branch: "main",
      token: "test-token",
      fetchImpl: fetchResponseFixture(
        branchProtectionResponseFixtures.invalidToken,
      ),
    }),
    /GITHUB_TOKEN or GH_TOKEN is valid and not expired/,
  );
});

test("treats an unprotected classic branch as empty so rulesets can protect it", async () => {
  const contexts = await readRequiredStatusContexts({
    apiBaseUrl: "https://api.example.test",
    repository: "owner/repo",
    branch: "main",
    token: "test-token",
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: "Branch not protected" }), {
        status: 404,
      }),
  });

  assert.deepEqual(contexts, []);
});

for (const fixture of [
  ...[401, 403, 404, 500].map((status) => ({
    name: `JSON HTTP ${status}`,
    status,
    body: JSON.stringify({
      message: "Authorization: Bearer ghs_fixture_secret_token; credential=fixture_private_credential",
      documentation_url: "https://example.test/?token=github_pat_fixture_secret",
    }),
  })),
  {
    name: "non-JSON HTTP 502",
    status: 502,
    body: "<html>Bearer ghs_fixture_secret_token; fixture_private_credential; github_pat_fixture_secret</html>",
  },
]) {
  test(`ruleset failure keeps status and guidance without printing credentials (${fixture.name})`, async () => {
    const expectedMessage =
      `GitHub branch-rules request failed with HTTP ${fixture.status}. The token needs repository Metadata: read permission.`;
    await assert.rejects(
      readApplicableRulesetRules({
        repository: "owner/repo",
        token: "ghs_fixture_secret_token",
        fetchImpl: async () => new Response(fixture.body, { status: fixture.status }),
      }),
      { message: expectedMessage },
    );

    // Exercise the actual CLI catch/log path without network access.
    const scriptUrl = new URL("./check-required-merge-checks.mjs", import.meta.url);
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      process.argv = [
        process.execPath, ${JSON.stringify(fileURLToPath(scriptUrl))},
        "--repo", "owner/repo", "--branch", "main",
        "--token", "ghs_fixture_secret_token"
      ];
      const fixture = ${JSON.stringify(fixture)};
      globalThis.fetch = async (url) => String(url).includes("/rules/branches/")
        ? new Response(fixture.body, { status: fixture.status })
        : new Response(JSON.stringify({ message: "Branch not protected" }), { status: 404 });
      await import(${JSON.stringify(scriptUrl.href)});
    `], { encoding: "utf8", timeout: 10_000 });

    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr.trim(), expectedMessage);
    assert.doesNotMatch(
      child.stdout + child.stderr,
      /ghs_fixture_secret_token|fixture_private_credential|github_pat_fixture_secret|Authorization: Bearer/,
    );
  });
}

test("reads applicable branch rulesets across response pages", async () => {
  const firstPage = Array.from({ length: 100 }, () => ({
    type: "non_required_rule",
  }));
  const calls = [];
  const rules = await readApplicableRulesetRules({
    apiBaseUrl: "https://api.example.test",
    repository: "owner/repo",
    branch: "release/next",
    token: "test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const page = new URL(String(url)).searchParams.get("page");
      return new Response(
        JSON.stringify(
          page === "1"
            ? firstPage
            : [
                {
                  type: "workflows",
                  ruleset_id: 42,
                  ruleset_source_type: "Organization",
                  ruleset_source: "owner",
                  parameters: {
                    workflows: [
                      {
                        path: ".github/workflows/required.yml",
                        ref: "main",
                        repository_id: 123,
                      },
                    ],
                  },
                },
                {
                  type: "required_status_checks",
                  ruleset_id: 43,
                  ruleset_source_type: "Repository",
                  ruleset_source: "owner/repo",
                  parameters: {
                    required_status_checks: [{ context: "native identity" }],
                  },
                },
              ],
        ),
        { status: 200 },
      );
    },
  });

  assert.equal(calls.length, 2);
  assert.match(
    calls[0].url,
    /\/rules\/branches\/release%2Fnext\?per_page=100&page=1$/,
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
  assert.equal(rules.length, 102);
  assert.deepEqual(extractRulesetMergeRequirements(rules), {
    requiredContexts: ["native identity"],
    requiredWorkflowPaths: [".github/workflows/required.yml"],
    requiredWorkflowRules: [
      {
        path: ".github/workflows/required.yml",
        repositoryId: 123,
      },
    ],
    rulesets: [
      { id: 42, sourceType: "Organization", source: "owner" },
      { id: 43, sourceType: "Repository", source: "owner/repo" },
    ],
  });
});

test("reads the current repository ID when workflow rules need identity matching", async () => {
  const repositoryId = await readRepositoryId({
    apiBaseUrl: "https://api.example.test",
    repository: "owner/repo",
    token: "test-token",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.example.test/repos/owner/repo");
      assert.equal(init.headers.Authorization, "Bearer test-token");
      return new Response(JSON.stringify({ id: 123 }), { status: 200 });
    },
  });

  assert.equal(repositoryId, 123);
});
