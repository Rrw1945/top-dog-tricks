import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workflowRoot = path.join(workspaceRoot, ".github", "workflows");
const defaultBranch = "main";

export const requiredMergeCheckContracts = Object.freeze([
  Object.freeze({
    workflowFile: "frontend-typecheck-refresh.yml",
    workflowName: "Frontend API type refresh",
    jobs: Object.freeze([
      Object.freeze({
        jobId: "frontend-typecheck-refresh",
        jobName: "Refresh API client declarations during frontend typecheck",
        protectedSteps: Object.freeze([
          Object.freeze({
            purpose: "generated API freshness",
            stepId: "api-codegen-drift",
            stepName: "Verify generated API code is in sync",
            run: "pnpm run check:api-codegen-drift",
          }),
        ]),
      }),
    ]),
  }),
  Object.freeze({
    workflowFile: "native-process-identity.yml",
    workflowName: "Native process identity probes",
    jobs: Object.freeze([
      Object.freeze({
        jobId: "process-identity",
        jobName: "${{ matrix.host }} Node.js ${{ matrix.node }} identity probe",
        matrix: Object.freeze([
          Object.freeze({ host: "macOS", node: 22 }),
          Object.freeze({ host: "macOS", node: 24 }),
          Object.freeze({ host: "Windows", node: 22 }),
          Object.freeze({ host: "Windows", node: 24 }),
        ]),
      }),
    ]),
  }),
]);

function stripYamlScalar(value) {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  if (
    withoutComment.length >= 2 &&
    ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
      (withoutComment.startsWith("'") && withoutComment.endsWith("'")))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

function workflowSectionLines(workflow, sectionName) {
  const lines = workflow.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) =>
    new RegExp(`^${sectionName}:\\s*$`).test(line),
  );
  if (sectionIndex === -1) {
    return [];
  }

  const endIndex = lines.findIndex(
    (line, index) =>
      index > sectionIndex &&
      line.trim() !== "" &&
      !line.startsWith(" ") &&
      !line.startsWith("\t") &&
      !line.trimStart().startsWith("#"),
  );
  return lines.slice(
    sectionIndex + 1,
    endIndex === -1 ? lines.length : endIndex,
  );
}

function workflowName(workflow) {
  const match = workflow.match(/^name:\s*(.*?)\s*$/m);
  return match ? stripYamlScalar(match[1]) : undefined;
}

function workflowJobs(workflow) {
  const lines = workflowSectionLines(workflow, "jobs");
  const jobs = new Map();

  for (const [index, line] of lines.entries()) {
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (!jobMatch) {
      continue;
    }

    const nextJobIndex = lines.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(candidate),
    );
    jobs.set(
      jobMatch[1],
      lines.slice(index + 1, nextJobIndex === -1 ? lines.length : nextJobIndex),
    );
  }

  return jobs;
}

function jobName(jobLines) {
  const match = jobLines.find((line) => /^ {4}name:\s*/.test(line));
  return match
    ? stripYamlScalar(match.replace(/^ {4}name:\s*/, ""))
    : undefined;
}

function workflowSteps(jobLines) {
  const starts = [];
  for (const [index, line] of jobLines.entries()) {
    if (/^ {6}-\s/.test(line)) {
      starts.push(index);
    }
  }

  return starts.map((startIndex, index) => {
    const endIndex = starts[index + 1] ?? jobLines.length;
    const lines = jobLines.slice(startIndex, endIndex);
    const readProperty = (property) => {
      const inlineMatch = lines[0]?.match(
        new RegExp(`^ {6}- ${property}:\\s*(.*?)\\s*$`),
      );
      if (inlineMatch) {
        return stripYamlScalar(inlineMatch[1]);
      }
      const match = lines.find((line) =>
        new RegExp(`^ {8}${property}:\\s*`).test(line),
      );
      return match
        ? stripYamlScalar(
            match.replace(new RegExp(`^ {8}${property}:\\s*`), ""),
          )
        : undefined;
    };

    return {
      id: readProperty("id"),
      name: readProperty("name"),
      run: readProperty("run"),
    };
  });
}

function matrixEntries(jobLines) {
  const includeIndex = jobLines.findIndex((line) =>
    /^ {8}include:\s*$/.test(line),
  );
  if (includeIndex === -1) {
    return [];
  }

  const entries = [];
  let entry;
  for (const line of jobLines.slice(includeIndex + 1)) {
    if (/^ {8}\S/.test(line)) {
      break;
    }
    const entryHostMatch = line.match(/^ {10}-\s*host:\s*(.*?)\s*$/);
    if (entryHostMatch) {
      if (entry) {
        entries.push(entry);
      }
      const host = stripYamlScalar(entryHostMatch[1]);
      entry = { host };
      continue;
    }
    const fieldMatch = line.match(/^ {12}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (fieldMatch) {
      entry ??= {};
      const value = stripYamlScalar(fieldMatch[2]);
      entry[fieldMatch[1]] = /^\d+$/.test(value) ? Number(value) : value;
    }
  }
  if (entry) {
    entries.push(entry);
  }
  return entries;
}

function expandJobName(template, matrix) {
  return template
    .replace(/\$\{\{\s*matrix\.host\s*\}\}/g, String(matrix.host))
    .replace(/\$\{\{\s*matrix\.node\s*\}\}/g, String(matrix.node));
}

function contractJobContexts(workflowNameValue, job) {
  const matrix = job.matrix ?? [undefined];
  return matrix.map((entry) => {
    const expandedName = entry
      ? expandJobName(job.jobName, entry)
      : job.jobName;
    return `${workflowNameValue} / ${expandedName}`;
  });
}

function actualJobContexts(workflowNameValue, jobDefinition, contractJob) {
  const matrix = matrixEntries(jobDefinition);
  if (matrix.length === 0) {
    return [
      `${workflowNameValue} / ${jobName(jobDefinition) ?? contractJob.jobName}`,
    ];
  }
  return matrix.map(
    (entry) =>
      `${workflowNameValue} / ${expandJobName(jobName(jobDefinition) ?? contractJob.jobName, entry)}`,
  );
}

export function inspectWorkflowDefinitions({
  workflows,
  contracts = requiredMergeCheckContracts,
}) {
  const expectedContexts = [];
  const actualContexts = [];
  const expectedWorkflowRules = [];
  const renamed = [];

  for (const contract of contracts) {
    const workflow = workflows?.[contract.workflowFile];
    const expectedWorkflowContexts = contract.jobs.flatMap((job) =>
      contractJobContexts(contract.workflowName, job),
    );
    expectedContexts.push(...expectedWorkflowContexts);
    expectedWorkflowRules.push({
      path: `.github/workflows/${contract.workflowFile}`,
      contexts: expectedWorkflowContexts,
    });

    if (typeof workflow !== "string") {
      renamed.push({
        kind: "missing-workflow",
        workflowFile: contract.workflowFile,
        expected: contract.workflowName,
        actual: undefined,
      });
      continue;
    }

    const actualWorkflowName = workflowName(workflow);
    if (actualWorkflowName !== contract.workflowName) {
      renamed.push({
        kind: "workflow",
        workflowFile: contract.workflowFile,
        expected: contract.workflowName,
        actual: actualWorkflowName ?? "(missing name)",
      });
    }

    const jobs = workflowJobs(workflow);
    for (const contractJob of contract.jobs) {
      const definition = jobs.get(contractJob.jobId);
      if (!definition) {
        renamed.push({
          kind: "missing-job",
          workflowFile: contract.workflowFile,
          jobId: contractJob.jobId,
          expected: contractJob.jobName,
          actual: undefined,
        });
        continue;
      }

      const actualJobName = jobName(definition);
      if (actualJobName !== contractJob.jobName) {
        renamed.push({
          kind: "job",
          workflowFile: contract.workflowFile,
          jobId: contractJob.jobId,
          expected: contractJob.jobName,
          actual: actualJobName ?? "(missing name)",
        });
      }

      if (contractJob.matrix) {
        const expectedMatrix = contractJob.matrix.map((entry) => ({
          host: entry.host,
          node: entry.node,
        }));
        const actualMatrix = matrixEntries(definition).map((entry) => ({
          host: entry.host,
          node: entry.node,
        }));
        if (JSON.stringify(actualMatrix) !== JSON.stringify(expectedMatrix)) {
          renamed.push({
            kind: "matrix",
            workflowFile: contract.workflowFile,
            jobId: contractJob.jobId,
            expected: expectedMatrix,
            actual: actualMatrix,
          });
        }
      }

      for (const protectedStep of contractJob.protectedSteps ?? []) {
        const steps = workflowSteps(definition);
        const actualStep = steps.find(
          (step) => step.id === protectedStep.stepId,
        );
        if (!actualStep) {
          const similarlyNamedStep = steps.find(
            (step) =>
              step.name === protectedStep.stepName ||
              step.run === protectedStep.run,
          );
          renamed.push({
            kind: "step",
            workflowFile: contract.workflowFile,
            jobId: contractJob.jobId,
            purpose: protectedStep.purpose,
            expected: {
              id: protectedStep.stepId,
              name: protectedStep.stepName,
              run: protectedStep.run,
            },
            actual: similarlyNamedStep,
          });
          continue;
        }

        if (actualStep.name !== protectedStep.stepName) {
          renamed.push({
            kind: "step-name",
            workflowFile: contract.workflowFile,
            jobId: contractJob.jobId,
            purpose: protectedStep.purpose,
            expected: protectedStep.stepName,
            actual: actualStep.name ?? "(missing name)",
          });
        }
        if (actualStep.run !== protectedStep.run) {
          renamed.push({
            kind: "step-command",
            workflowFile: contract.workflowFile,
            jobId: contractJob.jobId,
            purpose: protectedStep.purpose,
            expected: protectedStep.run,
            actual: actualStep.run ?? "(missing command)",
          });
        }
      }

      actualContexts.push(
        ...actualJobContexts(
          actualWorkflowName ?? "(missing workflow name)",
          definition,
          contractJob,
        ),
      );
    }
  }

  return {
    expectedContexts: sortedUniqueStrings(expectedContexts),
    actualContexts: sortedUniqueStrings(actualContexts),
    expectedWorkflowRules,
    renamed,
  };
}

function sortedUniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort(
    (left, right) => left.localeCompare(right),
  );
}

export function compareRequiredStatusContexts({
  requiredContexts,
  requiredWorkflowPaths = [],
  requiredWorkflowRules = [],
  expectedContexts,
  expectedWorkflowRules = [],
  actualWorkflowContexts = expectedContexts,
  renamed = [],
}) {
  const required = sortedUniqueStrings(requiredContexts);
  const expected = sortedUniqueStrings(expectedContexts);
  const requiredWorkflowEntries =
    requiredWorkflowRules.length > 0
      ? requiredWorkflowRules
      : requiredWorkflowPaths.map((workflowPath) => ({ path: workflowPath }));
  const workflowMatchesContract = (requiredWorkflow, expectedWorkflow) =>
    requiredWorkflow.path === expectedWorkflow.path &&
    requiredWorkflow.repositoryId === expectedWorkflow.repositoryId;
  const workflowCoveredContexts = new Set(
    expectedWorkflowRules
      .filter((workflow) =>
        requiredWorkflowEntries.some((requiredWorkflow) =>
          workflowMatchesContract(requiredWorkflow, workflow),
        ),
      )
      .flatMap((workflow) => workflow.contexts),
  );
  const requiredWorkflows = sortedUniqueStrings(
    requiredWorkflowEntries.map(formatRequiredWorkflowRule),
  );
  const expectedWorkflows = sortedUniqueStrings(
    expectedWorkflowRules.map(formatRequiredWorkflowRule),
  );
  const actual = sortedUniqueStrings(actualWorkflowContexts);
  const missing = expected.filter(
    (context) =>
      !required.includes(context) && !workflowCoveredContexts.has(context),
  );
  const extra = required.filter((context) => !expected.includes(context));
  const extraWorkflows = sortedUniqueStrings(
    requiredWorkflowEntries
      .filter(
        (requiredWorkflow) =>
          !expectedWorkflowRules.some((expectedWorkflow) =>
            workflowMatchesContract(requiredWorkflow, expectedWorkflow),
          ),
      )
      .map(formatRequiredWorkflowRule),
  );
  const workflowContextDrift = actual.filter(
    (context) => !expected.includes(context),
  );

  return {
    ok:
      renamed.length === 0 &&
      missing.length === 0 &&
      extra.length === 0 &&
      extraWorkflows.length === 0,
    required,
    expected,
    requiredWorkflows,
    expectedWorkflows,
    actual,
    missing,
    extra,
    extraWorkflows,
    workflowContextDrift,
    renamed,
  };
}

function formatRequiredWorkflowRule(workflow) {
  return Number.isInteger(workflow.repositoryId)
    ? `${workflow.path} (repository ID ${workflow.repositoryId})`
    : workflow.path;
}

export function formatMergeCheckAuditFailure({ branch, comparison }) {
  const lines = [
    "Required merge-check protection has drifted.",
    `Protected branch: ${branch}`,
  ];

  if (comparison.renamed.length > 0) {
    lines.push("Renamed or changed workflow checks:");
    for (const change of comparison.renamed) {
      const location = `${change.workflowFile}${change.jobId ? ` job ${change.jobId}` : ""}${change.purpose ? ` (${change.purpose} gate)` : ""}`;
      lines.push(
        `- ${location}: expected ${JSON.stringify(change.expected)}, found ${JSON.stringify(change.actual)}`,
      );
      if (change.purpose) {
        lines.push(
          `  Restore the protected ${change.purpose} step, or update its checked-in contract and branch protection together if the change is intentional.`,
        );
      }
    }
  }
  if (comparison.rulesets?.length > 0) {
    lines.push("Applicable active rulesets:");
    for (const ruleset of comparison.rulesets) {
      lines.push(`- ${ruleset.sourceType} ${ruleset.source} (#${ruleset.id})`);
    }
  }
  if (comparison.missing.length > 0) {
    lines.push("Missing required checks:");
    for (const context of comparison.missing) {
      lines.push(`- ${context}`);
    }
  }
  if (comparison.extra.length > 0) {
    lines.push("Extra required checks:");
    for (const context of comparison.extra) {
      lines.push(`- ${context}`);
    }
  }
  if (comparison.extraWorkflows.length > 0) {
    lines.push("Extra required workflow rules:");
    for (const workflow of comparison.extraWorkflows) {
      lines.push(`- ${workflow}`);
    }
  }
  if (comparison.workflowContextDrift.length > 0) {
    lines.push(
      "Checks currently published by the workflow but not in the intended contract:",
    );
    for (const context of comparison.workflowContextDrift) {
      lines.push(`- ${context}`);
    }
  }
  lines.push("Expected required checks:");
  lines.push(...comparison.expected.map((context) => `- ${context}`));
  lines.push("Protected branch currently requires:");
  lines.push(
    ...(comparison.required.length > 0
      ? comparison.required.map((context) => `- ${context}`)
      : ["- (none)"]),
  );
  lines.push("Protected branch currently requires workflows:");
  lines.push(
    ...(comparison.requiredWorkflows.length > 0
      ? comparison.requiredWorkflows.map((workflow) => `- ${workflow}`)
      : ["- (none)"]),
  );
  lines.push("Expected required workflows:");
  lines.push(
    ...(comparison.expectedWorkflows.length > 0
      ? comparison.expectedWorkflows.map((workflow) => `- ${workflow}`)
      : ["- (none)"]),
  );
  return lines.join("\n");
}

export async function readRequiredStatusContexts({
  apiBaseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  repository = process.env.GITHUB_REPOSITORY,
  branch = defaultBranch,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(
      "GITHUB_REPOSITORY must contain the repository as owner/name (or pass --repo owner/name).",
    );
  }
  if (!token) {
    throw new Error(
      "A GitHub token is required in GITHUB_TOKEN or GH_TOKEN; it must be able to read branch protection.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch.");
  }

  const response = await fetchImpl(
    `${apiBaseUrl.replace(/\/$/, "")}/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const location = `${repository}#${branch}`;
    if (response.status === 404) {
      if (
        typeof payload?.message === "string" &&
        payload.message.toLowerCase().includes("branch not protected")
      ) {
        return [];
      }
      throw new Error(
        `GitHub could not find branch protection for ${location}. Confirm the repository and branch names; if they are correct, add branch protection or a ruleset that requires the intended checks.`,
      );
    }
    if (response.status === 403) {
      throw new Error(
        `GitHub denied access to branch protection for ${location}. Grant the token repository Administration: read permission (or the equivalent fine-grained permission).`,
      );
    }
    if (response.status === 401) {
      throw new Error(
        `GitHub rejected the token while reading branch protection for ${location}. Check that GITHUB_TOKEN or GH_TOKEN is valid and not expired.`,
      );
    }
    throw new Error(
      `GitHub branch-protection request failed with HTTP ${response.status} for ${location}. Confirm the token can read branch protection, then retry the audit.`,
    );
  }

  if (payload === undefined) {
    throw new Error(
      "GitHub branch-protection request returned an unexpected response; expected valid JSON.",
    );
  }

  const requiredStatusChecks = payload?.required_status_checks;
  const contexts = [
    ...(Array.isArray(requiredStatusChecks?.contexts)
      ? requiredStatusChecks.contexts
      : []),
    ...(Array.isArray(requiredStatusChecks?.checks)
      ? requiredStatusChecks.checks.map((check) => check?.context)
      : []),
  ];
  return sortedUniqueStrings(contexts);
}

export async function readApplicableRulesetRules({
  apiBaseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  repository = process.env.GITHUB_REPOSITORY,
  branch = defaultBranch,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(
      "GITHUB_REPOSITORY must contain the repository as owner/name (or pass --repo owner/repo).",
    );
  }
  if (!token) {
    throw new Error(
      "A GitHub token is required in GITHUB_TOKEN or GH_TOKEN; it must be able to read repository metadata and branch protection.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch.");
  }

  const rules = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `${apiBaseUrl.replace(/\/$/, "")}/repos/${repository}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    const body = await response.text();
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      throw new Error(
        `GitHub branch-rules request failed with HTTP ${response.status}. The token needs repository Metadata: read permission.`,
      );
    }
    if (!Array.isArray(payload)) {
      throw new Error(
        "GitHub branch-rules request returned an unexpected response; expected an array of applicable rules.",
      );
    }

    rules.push(...payload);
    if (payload.length < 100) {
      return rules;
    }
  }
}

export async function readRepositoryId({
  apiBaseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(
      "GITHUB_REPOSITORY must contain the repository as owner/name (or pass --repo owner/repo).",
    );
  }
  if (!token) {
    throw new Error(
      "A GitHub token is required in GITHUB_TOKEN or GH_TOKEN; it must be able to read repository metadata.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch.");
  }

  const response = await fetchImpl(
    `${apiBaseUrl.replace(/\/$/, "")}/repos/${repository}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const detail =
      typeof payload?.message === "string" ? `: ${payload.message}` : "";
    throw new Error(
      `GitHub repository-metadata request failed with HTTP ${response.status}${detail}. The token needs repository Metadata: read permission.`,
    );
  }
  if (!Number.isInteger(payload?.id)) {
    throw new Error(
      "GitHub repository-metadata request returned an unexpected response; expected a numeric repository ID.",
    );
  }
  return payload.id;
}

export function extractRulesetMergeRequirements(rules) {
  const requiredContexts = [];
  const requiredWorkflowPaths = [];
  const requiredWorkflowRules = new Map();
  const rulesets = new Map();

  for (const rule of rules) {
    if (Number.isInteger(rule?.ruleset_id)) {
      const sourceType =
        typeof rule.ruleset_source_type === "string"
          ? rule.ruleset_source_type
          : "Unknown";
      const source =
        typeof rule.ruleset_source === "string"
          ? rule.ruleset_source
          : "unknown source";
      const key = `${sourceType}:${source}:${rule.ruleset_id}`;
      rulesets.set(key, {
        id: rule.ruleset_id,
        sourceType,
        source,
      });
    }

    if (rule?.type === "required_status_checks") {
      requiredContexts.push(
        ...(Array.isArray(rule.parameters?.required_status_checks)
          ? rule.parameters.required_status_checks.map(
              (check) => check?.context,
            )
          : []),
      );
    }
    if (rule?.type === "workflows") {
      for (const workflow of Array.isArray(rule.parameters?.workflows)
        ? rule.parameters.workflows
        : []) {
        if (typeof workflow?.path !== "string") {
          continue;
        }
        requiredWorkflowPaths.push(workflow.path);
        const repositoryId = Number.isInteger(workflow.repository_id)
          ? workflow.repository_id
          : undefined;
        requiredWorkflowRules.set(
          `${repositoryId ?? "unknown"}:${workflow.path}`,
          { path: workflow.path, repositoryId },
        );
      }
    }
  }

  return {
    requiredContexts: sortedUniqueStrings(requiredContexts),
    requiredWorkflowPaths: sortedUniqueStrings(requiredWorkflowPaths),
    requiredWorkflowRules: [...requiredWorkflowRules.values()].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        (left.repositoryId ?? 0) - (right.repositoryId ?? 0),
    ),
    rulesets: [...rulesets.values()].sort(
      (left, right) =>
        left.source.localeCompare(right.source) || left.id - right.id,
    ),
  };
}

async function readWorkflowFiles(contracts) {
  return Object.fromEntries(
    await Promise.all(
      contracts.map(async (contract) => [
        contract.workflowFile,
        await readFile(
          path.join(workflowRoot, contract.workflowFile),
          "utf8",
        ).catch((error) => {
          if (error?.code === "ENOENT") {
            return undefined;
          }
          throw error;
        }),
      ]),
    ),
  );
}

function parseArguments(argumentsList) {
  const options = {
    branch: process.env.GITHUB_BRANCH ?? defaultBranch,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    apiBaseUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    repositoryId: /^\d+$/.test(process.env.GITHUB_REPOSITORY_ID ?? "")
      ? Number(process.env.GITHUB_REPOSITORY_ID)
      : undefined,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      console.log(
        [
          "Usage: pnpm run check:required-merge-checks [options]",
          "",
          "Options:",
          "  --repo OWNER/REPOSITORY  Repository to audit",
          "  --branch BRANCH          Protected branch (default: main)",
          "  --token TOKEN            GitHub token (prefer GITHUB_TOKEN)",
          "  --api-url URL            GitHub API base URL",
        ].join("\n"),
      );
      return { help: true };
    }
    if (!["--branch", "--repo", "--token", "--api-url"].includes(argument)) {
      throw new Error(`Unknown argument "${argument}".`);
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Argument ${argument} requires a value.`);
    }
    index += 1;
    if (argument === "--branch") options.branch = value;
    if (argument === "--repo") options.repository = value;
    if (argument === "--token") options.token = value;
    if (argument === "--api-url") options.apiBaseUrl = value;
  }
  return options;
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.exitCode = 0;
      process.exit();
    }
    const workflows = await readWorkflowFiles(requiredMergeCheckContracts);
    const definitions = inspectWorkflowDefinitions({ workflows });
    const [branchProtectionContexts, applicableRules] = await Promise.all([
      readRequiredStatusContexts(options),
      readApplicableRulesetRules(options),
    ]);
    const rulesetRequirements =
      extractRulesetMergeRequirements(applicableRules);
    const repositoryId =
      rulesetRequirements.requiredWorkflowRules.length === 0
        ? undefined
        : (options.repositoryId ?? (await readRepositoryId(options)));
    const comparison = compareRequiredStatusContexts({
      requiredContexts: [
        ...branchProtectionContexts,
        ...rulesetRequirements.requiredContexts,
      ],
      requiredWorkflowRules: rulesetRequirements.requiredWorkflowRules,
      expectedContexts: definitions.expectedContexts,
      expectedWorkflowRules: definitions.expectedWorkflowRules.map(
        (workflow) => ({ ...workflow, repositoryId }),
      ),
      actualWorkflowContexts: definitions.actualContexts,
      renamed: definitions.renamed,
    });
    comparison.rulesets = rulesetRequirements.rulesets;

    if (!comparison.ok) {
      throw new Error(
        formatMergeCheckAuditFailure({
          branch: options.branch,
          comparison,
        }),
      );
    }

    console.log(
      `Required merge checks for ${options.repository}#${options.branch} match ${comparison.expected.length} intended workflow context(s); found ${comparison.rulesets.length} applicable active ruleset(s).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
