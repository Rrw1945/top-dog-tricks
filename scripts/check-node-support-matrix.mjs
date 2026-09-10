import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJsonPath = path.join(workspaceRoot, "package.json");
const workflowDirectory = path.join(workspaceRoot, ".github", "workflows");
const nativeProcessWorkflowName = "native-process-identity.yml";

export const workflowNodeVersionPolicies = Object.freeze({
  [nativeProcessWorkflowName]: Object.freeze({
    match: "exact",
  }),
  "frontend-typecheck-refresh.yml": Object.freeze({
    match: "allow-list",
    versions: Object.freeze([24]),
    reason:
      "The frontend refresh workflow intentionally smoke-tests only the newest supported Node major.",
  }),
});

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function supportedNodeMajors(nodeRange) {
  if (typeof nodeRange !== "string" || nodeRange.trim() === "") {
    throw new Error(
      'package.json must define a non-empty "engines.node" range',
    );
  }

  const majors = [];
  for (const alternative of nodeRange.split("||")) {
    const match = alternative.match(
      /^\s*(?:(?:<=|>=|<|>|=|~|\^)\s*)?v?([1-9]\d*)(?:\.\d+){0,2}\s*$/,
    );
    if (!match) {
      throw new Error(
        `Unsupported engines.node alternative "${alternative.trim()}"; expected a single Node major version with an optional semver operator`,
      );
    }
    majors.push(Number(match[1]));
  }

  return sortedUnique(majors);
}

export function workflowNodeMajors(workflow) {
  const majors = [];
  const declarationPattern =
    /^\s*(?:node|node-version):\s*(?:(?:["']?)(\d+)(?:\.\d+){0,2}(?:\.x)?["']?|(\[[^\]]*\]))\s*(?:#.*)?$/gm;

  for (const match of workflow.matchAll(declarationPattern)) {
    if (match[1]) {
      majors.push(Number(match[1]));
      continue;
    }

    for (const version of match[2].matchAll(
      /["']?(\d+)(?:\.\d+){0,2}(?:\.x)?["']?/g,
    )) {
      majors.push(Number(version[1]));
    }
  }

  if (majors.length === 0) {
    throw new Error(
      "Could not find any explicit Node versions in the workflow",
    );
  }

  return sortedUnique(majors);
}

function workflowDeclaresNodeVersion(workflow) {
  return /^\s*(?:node|node-version):\s*/m.test(workflow);
}

function workflowMatchesPolicy(supported, matrix, policy) {
  if (policy.match === "allow-list") {
    return (
      matrix.every((major) => supported.includes(major)) &&
      matrix.join(",") === policy.versions.join(",")
    );
  }

  if (policy.match === "exact") {
    return supported.join(",") === matrix.join(",");
  }

  throw new Error(`Unsupported workflow Node version policy "${policy.match}"`);
}

function workflowTriggerSections(workflow) {
  const lines = workflow.split(/\r?\n/);
  const onHeaders = lines.reduce((matches, line, index) => {
    if (/^["']?on["']?\s*:\s*(?:#.*)?$/.test(line)) {
      matches.push(index);
    }
    return matches;
  }, []);

  if (onHeaders.length !== 1) {
    return [];
  }

  const onHeaderIndex = onHeaders[0];
  const onEndIndex = lines.findIndex(
    (line, index) =>
      index > onHeaderIndex &&
      line.trim() !== "" &&
      !line.startsWith(" ") &&
      !line.startsWith("\t") &&
      !line.trimStart().startsWith("#"),
  );
  const triggerLines = lines.slice(
    onHeaderIndex + 1,
    onEndIndex === -1 ? lines.length : onEndIndex,
  );
  const sections = [];

  for (const [index, line] of triggerLines.entries()) {
    const match = line.match(/^ {2}(["']?)([A-Za-z][\w-]*)\1\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }

    const nextSectionIndex = triggerLines.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        /^ {2}(["']?)[A-Za-z][\w-]*\1\s*:\s*/.test(candidate),
    );
    sections.push({
      name: match[2],
      inlineValue: match[3],
      lines: triggerLines.slice(
        index + 1,
        nextSectionIndex === -1 ? triggerLines.length : nextSectionIndex,
      ),
    });
  }

  return sections;
}

function sectionHasMainBranch(section) {
  const branchesHeaderIndex = section.lines.findIndex((line) =>
    /^ {4}branches\s*:/.test(line),
  );
  if (branchesHeaderIndex === -1) {
    return false;
  }

  const branchesHeader = section.lines[branchesHeaderIndex];
  const inlineValue = branchesHeader.replace(/^ {4}branches\s*:\s*/, "");
  if (/(?:^|\[|,)\s*["']?main["']?\s*(?:,|\]|$)/.test(inlineValue)) {
    return true;
  }

  for (const line of section.lines.slice(branchesHeaderIndex + 1)) {
    if (line.trim() !== "" && /^ {4}\S/.test(line)) {
      break;
    }
    if (/^ {6}-\s*["']?main["']?\s*(?:#.*)?$/.test(line)) {
      return true;
    }
  }

  return false;
}

function scheduleEntryCount(sections) {
  return sections
    .filter((section) => section.name === "schedule")
    .reduce(
      (count, section) =>
        count +
        section.lines.filter((line) =>
          /^\s*-\s*["']?cron["']?\s*:/.test(line),
        ).length,
      0,
    );
}

export function checkNativeProcessWorkflowContract({ workflows }) {
  const nativeProcessWorkflow = workflows?.[nativeProcessWorkflowName];
  const problems = [];

  if (typeof nativeProcessWorkflow !== "string") {
    throw new Error(
      `Missing .github/workflows/${nativeProcessWorkflowName}; the native process workflow is required`,
    );
  }

  const nativeSections = workflowTriggerSections(nativeProcessWorkflow);
  const countTrigger = (name) =>
    nativeSections.filter((section) => section.name === name).length;

  if (countTrigger("pull_request") !== 1) {
    problems.push("must declare exactly one pull_request trigger");
  }

  const pushSections = nativeSections.filter((section) => section.name === "push");
  if (pushSections.length !== 1 || !sectionHasMainBranch(pushSections[0])) {
    problems.push("must declare a push trigger for the main branch");
  }

  if (countTrigger("workflow_dispatch") !== 1) {
    problems.push("must declare exactly one workflow_dispatch trigger");
  }

  const scheduleSections = nativeSections.filter(
    (section) => section.name === "schedule",
  );
  const nativeScheduleEntries = scheduleEntryCount(nativeSections);
  if (scheduleSections.length !== 1 || nativeScheduleEntries !== 1) {
    problems.push(
      `must declare exactly one recurring schedule trigger (found ${nativeScheduleEntries})`,
    );
  }

  const scheduledWorkflowNames = Object.entries(workflows ?? {})
    .filter(
      ([, workflow]) =>
        typeof workflow === "string" &&
        scheduleEntryCount(workflowTriggerSections(workflow)) > 0,
    )
    .map(([workflowName]) => workflowName)
    .sort();
  if (
    scheduledWorkflowNames.length !== 1 ||
    scheduledWorkflowNames[0] !== nativeProcessWorkflowName
  ) {
    problems.push(
      `the only scheduled workflow must be .github/workflows/${nativeProcessWorkflowName}; found ${scheduledWorkflowNames.length > 0 ? scheduledWorkflowNames.map((name) => `.github/workflows/${name}`).join(", ") : "none"}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "The native process workflow trigger contract has drifted.",
        `Workflow: .github/workflows/${nativeProcessWorkflowName}`,
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }

  return {
    workflow: nativeProcessWorkflowName,
    scheduledWorkflows: scheduledWorkflowNames,
    scheduleEntries: nativeScheduleEntries,
  };
}

export function checkNodeSupportMatrix({ packageJson, workflows, workflow }) {
  const supported = supportedNodeMajors(packageJson?.engines?.node);
  const isLegacySingleWorkflowCall = typeof workflow === "string";
  const workflowEntries = workflows
    ? Object.entries(workflows)
    : [["native-process-identity.yml", workflow]];
  const checkedWorkflows = [];
  const drift = [];

  for (const [workflowName, workflowContents] of workflowEntries) {
    if (
      typeof workflowContents !== "string" ||
      !workflowDeclaresNodeVersion(workflowContents)
    ) {
      continue;
    }

    const matrix = workflowNodeMajors(workflowContents);
    const policy = workflowNodeVersionPolicies[workflowName] ?? {
      match: "exact",
    };
    checkedWorkflows.push({
      workflow: workflowName,
      matrix,
      policy: policy.match,
    });

    if (!workflowMatchesPolicy(supported, matrix, policy)) {
      drift.push(
        [
          `Workflow: .github/workflows/${workflowName}`,
          `Supported Node versions from package.json: ${JSON.stringify(supported)}`,
          `Declared Node versions: ${JSON.stringify(matrix)}`,
          `Policy: ${policy.match}${policy.versions ? ` ${JSON.stringify(policy.versions)}` : ""}${policy.reason ? ` (${policy.reason})` : ""}`,
        ].join("\n"),
      );
    }
  }

  if (drift.length > 0) {
    throw new Error(
      ["Node support and workflow declarations have drifted.", ...drift].join(
        "\n",
      ),
    );
  }

  if (isLegacySingleWorkflowCall) {
    return { supported, matrix: checkedWorkflows[0]?.matrix ?? [] };
  }

  return { supported, workflows: checkedWorkflows };
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const workflowNames = (await readdir(workflowDirectory))
    .filter((name) => /\.(?:yaml|yml)$/i.test(name))
    .sort();
  const workflows = Object.fromEntries(
    await Promise.all(
      workflowNames.map(async (workflowName) => [
        workflowName,
        await readFile(path.join(workflowDirectory, workflowName), "utf8"),
      ]),
    ),
  );
  checkNativeProcessWorkflowContract({ workflows });
  const { supported, workflows: checkedWorkflows } = checkNodeSupportMatrix({
    packageJson,
    workflows,
  });

  console.log(
    `Node support matches ${checkedWorkflows.length} workflow(s): ${supported.join(", ")}`,
  );
}
