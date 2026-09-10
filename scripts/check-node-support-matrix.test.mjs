import assert from "node:assert/strict";
import test from "node:test";

import {
  checkNativeProcessWorkflowContract,
  checkNodeSupportMatrix,
  supportedNodeMajors,
  workflowNodeMajors,
} from "./check-node-support-matrix.mjs";

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

test("parses valid alternative ranges and removes duplicate majors", () => {
  assert.deepEqual(
    supportedNodeMajors(" ^22.0.0 || v24 || >=22.1.0 || ~24.2.0 "),
    [22, 24],
  );
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

test("allows the explicit frontend workflow Node 24 policy", () => {
  assert.deepEqual(
    checkNodeSupportMatrix({
      packageJson: { engines: { node: "^22.0.0 || ^24.0.0" } },
      workflows: {
        "frontend-typecheck-refresh.yml": `
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
          workflow: "frontend-typecheck-refresh.yml",
          matrix: [24],
          policy: "allow-list",
        },
      ],
    },
  );
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
      error.message.includes("exactly one recurring schedule trigger (found 2)"),
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
      error.message.includes("the only scheduled workflow must be") &&
      error.message.includes(".github/workflows/second-native-process.yml"),
  );
});
