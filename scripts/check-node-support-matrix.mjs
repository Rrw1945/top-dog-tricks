import { lstat, readlink, realpath, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJsonPath = path.join(workspaceRoot, "package.json");
const nativeProcessWorkflowName = "native-process-identity.yml";
export const nativeProcessCoverage = Object.freeze({
  hosts: Object.freeze([
    Object.freeze({ host: "macOS", os: "macos-latest" }),
    Object.freeze({ host: "Windows", os: "windows-latest" }),
  ]),
  nodeMajors: Object.freeze([22, 24]),
});
export const requiredNativeProcessMatrixEntries = Object.freeze(
  nativeProcessCoverage.hosts.flatMap(({ host, os }) =>
    nativeProcessCoverage.nodeMajors.map((node) =>
      Object.freeze({ host, os, node }),
    ),
  ),
);
const supportedNativeProcessMatrixHosts = new Set(
  requiredNativeProcessMatrixEntries.map(({ host }) => host),
);
const supportedNativeProcessMatrixRunners = new Set(
  requiredNativeProcessMatrixEntries.map(({ os }) => os),
);
const supportedNativeProcessMatrixNodes = new Set(
  requiredNativeProcessMatrixEntries.map(({ node }) => node),
);
const supportedNativeProcessMatrixEntryKeys = new Set(
  requiredNativeProcessMatrixEntries.map(
    ({ host, os, node }) => `${host}|${os}|${String(node)}`,
  ),
);
const requiredNativeProcessProbeCommands = Object.freeze([
  "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native",
  "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-transition-exit",
  "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-timeout",
  "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-descendant-lifecycle",
  "pnpm run check:api-typecheck-rebuilds-libs:process-identity:recovery",
  "pnpm run check:api-typecheck-rebuilds-libs:interrupted-publication",
]);
const nativeProcessNodeSupportRegressionCommand =
  "pnpm run test:node-support-matrix";
const httpShutdownTestCommand = "pnpm --filter @workspace/api-server test";
const httpShutdownTestFile = "src/lib/httpShutdown.test.ts";
const nativeInterruptionTestFile = "scripts/check-native-transition-interruption.test.mjs";
const nativeInterruptionTestCommand = `node --test ${nativeInterruptionTestFile}`;
const httpShutdownTriggerPaths = [
  "artifacts/api-server/src/lib/httpShutdown.ts",
  `artifacts/api-server/${httpShutdownTestFile}`,
];
const nativeProcessNodeSupportSynchronizationCommand =
  "pnpm run check:node-support-matrix";
const nativeProcessRecoveryDiagnosticsValidationCommand =
  "pnpm exec node ./scripts/check-api-typecheck-rebuilds-db.mjs --verify-native-process-recovery-diagnostics";
const requiredInterruptedPublicationRecoveryRuns = 3;
const nativeProcessFailureAttributionCommand =
  "pnpm exec node ./scripts/check-api-typecheck-rebuilds-db.mjs --record-native-process-probe-failure";
export const requiredNativeProcessProbePhases = Object.freeze([
  "identity",
  "filesystem-setup",
  "transition-locking",
  "filesystem-cleanup",
]);
const nativeProcessFailureAttributions = Object.freeze([
  Object.freeze({
    step: "node-support-matrix-tests",
    label: "node-support-matrix-tests",
    command: nativeProcessNodeSupportRegressionCommand,
  }),
  Object.freeze({
    step: "node-support-matrix-contract",
    label: "node-support-matrix-contract",
    command: nativeProcessNodeSupportSynchronizationCommand,
  }),
  Object.freeze({
    step: "native-process-identity",
    label: "stale-lock-takeover",
    command: requiredNativeProcessProbeCommands[0],
  }),
  Object.freeze({
    step: "native-process-identity-transition-exit",
    label: "transition-lock-owner-exit",
    command: requiredNativeProcessProbeCommands[1],
  }),
  Object.freeze({
    step: "native-process-identity-timeout",
    label: "frozen-probe-timeout",
    command: requiredNativeProcessProbeCommands[2],
  }),
  Object.freeze({
    step: "native-process-identity-descendant-lifecycle",
    label: "frozen-probe-descendant-cleanup",
    command: requiredNativeProcessProbeCommands[3],
  }),
  Object.freeze({
    step: "native-process-identity-recovery",
    label: "pid-reuse-recovery-batch",
    command: requiredNativeProcessProbeCommands[4],
  }),
  Object.freeze({
    step: "native-process-identity-recovery-record",
    label: "pid-reuse-recovery-record-validation",
    command: nativeProcessRecoveryDiagnosticsValidationCommand,
  }),
  Object.freeze({
    step: "interrupted-publication-recovery",
    label: "windows-interrupted-publication",
    command: requiredNativeProcessProbeCommands[5],
  }),
]);

export const workflowNodeVersionPolicies = Object.freeze({
  [nativeProcessWorkflowName]: Object.freeze({
    match: "exact",
  }),
  "frontend-typecheck-refresh.yml": Object.freeze({
    match: "exact",
  }),
  "newsletter-funnel-clickhouse.yml": Object.freeze({
    match: "allow-list",
    versions: Object.freeze([24]),
    reason:
      "The newsletter funnel workflow intentionally smoke-tests only the newest supported Node major.",
  }),
  "required-merge-checks.yml": Object.freeze({
    match: "allow-list",
    versions: Object.freeze([24]),
    reason:
      "The required merge-check audit only needs the newest supported Node major.",
  }),
  "prize-layout.yml": Object.freeze({
    match: "allow-list",
    versions: Object.freeze([24]),
    reason:
      "The browser layout workflow checks Chromium geometry, not Node compatibility, on the newest supported Node major.",
  }),
  "welcome-recovery-postgres.yml": Object.freeze({
    match: "exact",
  }),
});

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

const numericNodeVersionPattern =
  /^["']?v?([1-9]\d*)(?:\.\d+){0,2}(?:\.x)?["']?$/;

function stripInlineComment(value) {
  return value
    .replace(/^\s*#.*$/, "")
    .replace(/\s+#.*$/, "")
    .trim();
}

function unquoteYamlScalar(value) {
  const trimmed = stripInlineComment(value);
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseNumericNodeVersion(value) {
  const match = unquoteYamlScalar(value).match(numericNodeVersionPattern);
  return match ? Number(match[1]) : null;
}

function parseNodeVersionValue(
  value,
  { source, unsupported, includeValue = true },
) {
  const trimmed = stripInlineComment(value);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const versions = trimmed
      .slice(1, -1)
      .split(",")
      .map((version) => version.trim())
      .filter(Boolean);
    for (const version of versions) {
      const major = parseNumericNodeVersion(version);
      if (major === null) {
        unsupported.push(
          includeValue
            ? `${source} uses unsupported Node version "${version}"`
            : `${source} contains an unsupported Node version; expected an explicit numeric Node version`,
        );
      }
    }
    return versions
      .map((version) => parseNumericNodeVersion(version))
      .filter((major) => major !== null);
  }

  const major = parseNumericNodeVersion(trimmed);
  if (major !== null) {
    return [major];
  }

  if (/^\$\{\{.*\}\}$/.test(trimmed)) {
    return [];
  }

  unsupported.push(
    includeValue
      ? `${source} uses unsupported Node version "${unquoteYamlScalar(trimmed)}"; aliases are not supported because they cannot be compared to package.json engines.node`
      : `${source} contains an unsupported Node version; aliases are not supported because they cannot be compared to package.json engines.node`,
  );
  return [];
}

function normalizedVersionFileReference(value) {
  const reference = unquoteYamlScalar(value);
  return reference.startsWith("./") ? reference.slice(2) : reference;
}

function resolveWorkspaceVersionFilePath(
  reference,
  repositoryRoot = workspaceRoot,
) {
  const root = path.resolve(repositoryRoot);
  const resolvedPath = path.resolve(root, reference);
  const relativePath = path.relative(root, resolvedPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `node-version-file "${reference}" must reference a path within the repository`,
    );
  }
  return resolvedPath;
}

function* nodeVersionDeclarations(workflow) {
  const pattern =
    /^\s*(["']?)(node|node-version|node-version-file)\1:\s*(.*?)\s*(?:#.*)?$/gm;
  for (const match of workflow.matchAll(pattern)) {
    yield { declaration: match[2], value: match[3] };
  }
}

function nodeVersionFilePaths(workflow) {
  const paths = [];

  for (const { declaration, value } of nodeVersionDeclarations(workflow)) {
    if (declaration !== "node-version-file") continue;
    const reference = normalizedVersionFileReference(value);
    if (reference && !reference.startsWith("${{")) {
      paths.push(reference);
    }
  }

  return [...new Set(paths)];
}

function versionFileWorkflowError(workflowName, error) {
  return new Error(
    [
      `Workflow: .github/workflows/${workflowName}`,
      `Validation: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n"),
  );
}

export async function loadNodeVersionFiles(
  workflows,
  options = {},
) {
  const { nodeVersionFiles } = await loadNodeVersionFileInputs(workflows, options);
  return nodeVersionFiles;
}

async function versionFileLinkDependencies(realRoot, relativePath, reference) {
  const dependencies = new Set();
  let current = realRoot;
  let remaining = relativePath.split(path.sep).filter(Boolean);
  let links = 0;
  while (remaining.length > 0) {
    current = path.resolve(current, remaining.shift());
    const relative = path.relative(realRoot, current);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `node-version-file "${reference}" resolves outside the repository`,
      );
    }
    if (!(await lstat(current)).isSymbolicLink()) continue;
    dependencies.add(relative.split(path.sep).join("/"));
    // Bound traversal even if links change after the initial realpath check.
    if (++links > 40) throw new Error(`node-version-file "${reference}" has too many symbolic links`);
    const target = await readlink(current);
    if (path.isAbsolute(target)) {
      if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error(
          `node-version-file "${reference}" resolves outside the repository`,
        );
      }
      remaining = [...target.slice(realRoot.length).split(path.sep).filter(Boolean), ...remaining];
      current = realRoot;
    } else {
      // Do not normalize ".." before visiting the preceding component: that
      // component may itself be a directory symlink.
      remaining = [...target.split(path.sep).filter(Boolean), ...remaining];
      current = path.dirname(current);
    }
  }
  return [...dependencies];
}

export async function loadNodeVersionFileInputs(
  workflows,
  { repositoryRoot = workspaceRoot } = {},
) {
  const root = path.resolve(repositoryRoot);
  const realRoot = await realpath(root);
  const nodeVersionFiles = Object.create(null);
  const nodeVersionFileTargets = Object.create(null);
  const nodeVersionFileDependencies = Object.create(null);

  for (const [workflowName, workflow] of Object.entries(workflows)) {
    if (typeof workflow !== "string") {
      continue;
    }

    for (const reference of nodeVersionFilePaths(workflow)) {
      if (Object.hasOwn(nodeVersionFiles, reference)) {
        continue;
      }

      let lexicalTarget;
      try {
        lexicalTarget = resolveWorkspaceVersionFilePath(reference, root);
      } catch (error) {
        throw versionFileWorkflowError(workflowName, error);
      }

      let resolvedTarget;
      try {
        resolvedTarget = await realpath(lexicalTarget);
      } catch {
        // Preserve the existing "could not be read" validation for missing or
        // otherwise inaccessible version files without ever reading the link.
        nodeVersionFiles[reference] = undefined;
        continue;
      }

      const relativeTarget = path.relative(realRoot, resolvedTarget);
      if (
        relativeTarget === ".." ||
        relativeTarget.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTarget)
      ) {
        throw versionFileWorkflowError(
          workflowName,
          new Error(
            `node-version-file "${reference}" resolves outside the repository`,
          ),
        );
      }

      // GitHub path filters use repository-relative POSIX paths, including on
      // Windows. Keep the declaration as well as the canonical target.
      nodeVersionFileTargets[reference] = relativeTarget.split(path.sep).join("/");
      try {
        nodeVersionFileDependencies[reference] = await versionFileLinkDependencies(
          realRoot, path.relative(root, lexicalTarget), reference,
        );
      } catch (error) {
        throw versionFileWorkflowError(workflowName, error);
      }
      try {
        nodeVersionFiles[reference] = await readFile(resolvedTarget, "utf8");
      } catch {
        nodeVersionFiles[reference] = undefined;
      }
    }
  }

  return { nodeVersionFiles, nodeVersionFileTargets, nodeVersionFileDependencies };
}

function parseNodeVersionFile(reference, contents, unsupported) {
  if (typeof contents !== "string") {
    unsupported.push(
      `node-version-file "${reference}" could not be read; use a checked-in file with an explicit numeric Node version`,
    );
    return [];
  }

  if (path.posix.basename(reference) === "package.json") {
    try {
      const packageJson = JSON.parse(contents);
      return supportedNodeMajors(packageJson?.engines?.node);
    } catch (error) {
      unsupported.push(
        `node-version-file "${reference}" must contain a valid package.json with a supported engines.node range`,
      );
      return [];
    }
  }

  const values = contents
    .split(/\r?\n/)
    .map((line) => stripInlineComment(line))
    .filter((line) => line !== "");
  if (path.posix.basename(reference) === ".tool-versions") {
    const nodeVersionLines = values.filter((line) => /^nodejs(?:\s|$)/.test(line));
    if (nodeVersionLines.length === 0) {
      unsupported.push(
        `node-version-file "${reference}" must declare a nodejs version`,
      );
      return [];
    }
    if (nodeVersionLines.length > 1) {
      unsupported.push(
        `node-version-file "${reference}" must contain exactly one nodejs entry`,
      );
      return [];
    }
    const nodeVersion = nodeVersionLines[0].replace(/^nodejs\s*/, "");
    if (nodeVersion === "") {
      unsupported.push(
        `node-version-file "${reference}" has a nodejs entry without a version; add an explicit numeric Node version after nodejs`,
      );
      return [];
    }
    return parseNodeVersionValue(nodeVersion, {
      source: `node-version-file "${reference}"`,
      unsupported,
      includeValue: false,
    });
  }

  if (values.length !== 1) {
    unsupported.push(
      `node-version-file "${reference}" must contain exactly one explicit numeric Node version`,
    );
    return [];
  }

  return parseNodeVersionValue(values[0], {
    source: `node-version-file "${reference}"`,
    unsupported,
    includeValue: false,
  });
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

export function workflowNodeMajors(workflow, { nodeVersionFiles = {} } = {}) {
  const majors = [];
  const unsupported = [];

  for (const { declaration, value } of nodeVersionDeclarations(workflow)) {
    if (declaration === "node-version-file") {
      const reference = normalizedVersionFileReference(value);
      if (reference.startsWith("${{")) {
        unsupported.push(
          `node-version-file "${reference}" is dynamic; use a checked-in file path so its version can be validated`,
        );
      } else {
        resolveWorkspaceVersionFilePath(reference);
        majors.push(
          ...parseNodeVersionFile(
            reference,
            nodeVersionFiles[reference],
            unsupported,
          ),
        );
      }
      continue;
    }

    majors.push(
      ...parseNodeVersionValue(value, {
        source: `${declaration} declaration`,
        unsupported,
      }),
    );
  }

  if (unsupported.length > 0) {
    throw new Error(unsupported.join("; "));
  }

  if (majors.length === 0) {
    throw new Error(
      "Could not find any explicit Node versions in the workflow; dynamic expressions require a numeric matrix declaration",
    );
  }

  return sortedUnique(majors);
}

function workflowDeclaresNodeVersion(workflow) {
  return !nodeVersionDeclarations(workflow).next().done;
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

function splitInlineYaml(value) {
  const entries = [];
  let entryStart = 0;
  let quote;
  let nesting = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{") {
      nesting += 1;
      continue;
    }
    if (character === "]" || character === "}") {
      nesting -= 1;
      continue;
    }
    if (character === "," && nesting === 0) {
      entries.push(value.slice(entryStart, index).trim());
      entryStart = index + 1;
    }
  }

  const finalEntry = value.slice(entryStart).trim();
  if (finalEntry) {
    entries.push(finalEntry);
  }
  return entries;
}

function inlineYamlColonIndex(value) {
  let quote;
  let nesting = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{") {
      nesting += 1;
      continue;
    }
    if (character === "]" || character === "}") {
      nesting -= 1;
      continue;
    }
    if (character === ":" && nesting === 0) {
      return index;
    }
  }

  return -1;
}

function validateInlineYaml(value) {
  const delimiters = [];
  let quote;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (
        character === "'" &&
        quote === "'" &&
        value[index + 1] === "'"
      ) {
        index += 1;
        continue;
      }
      if (character === quote && value[index - 1] !== "\\") {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === "[" || character === "{") {
      delimiters.push(character);
      continue;
    }

    if (character === "]" || character === "}") {
      const expectedOpening = character === "]" ? "[" : "{";
      if (delimiters.pop() !== expectedOpening) {
        throw new Error(
          "Unsupported GitHub Actions trigger syntax: mismatched flow-style delimiters",
        );
      }
    }
  }

  if (quote) {
    throw new Error(
      "Unsupported GitHub Actions trigger syntax: unterminated quoted trigger",
    );
  }
  if (delimiters.length > 0) {
    throw new Error(
      "Unsupported GitHub Actions trigger syntax: unterminated flow-style map or list",
    );
  }
}

function triggerSection(name, inlineValue = "") {
  return {
    name,
    inlineValue,
    lines: [],
  };
}

function inlineTriggerSections(value) {
  const trimmed = stripInlineComment(value);
  if (!trimmed) {
    return [];
  }

  validateInlineYaml(trimmed);

  if (/^[|>][+-]?$/.test(trimmed)) {
    throw new Error(
      "Unsupported GitHub Actions trigger syntax: multiline trigger values are not supported",
    );
  }

  const startsWithList = trimmed.startsWith("[");
  const endsWithList = trimmed.endsWith("]");
  const startsWithMap = trimmed.startsWith("{");
  const endsWithMap = trimmed.endsWith("}");
  if (startsWithList !== endsWithList || startsWithMap !== endsWithMap) {
    throw new Error(
      "Unsupported GitHub Actions trigger syntax: flow-style trigger must be a complete map or list",
    );
  }

  const isList = startsWithList && endsWithList;
  const isMap = startsWithMap && endsWithMap;
  if (!isList && !isMap) {
    const name = unquoteYamlScalar(trimmed);
    if (!/^[A-Za-z][\w-]*$/.test(name)) {
      throw new Error(
        "Unsupported GitHub Actions trigger syntax: expected an event name, map, or list",
      );
    }
    return [triggerSection(name)];
  }

  const entries = splitInlineYaml(
    isList || isMap ? trimmed.slice(1, -1) : trimmed,
  );

  return entries.map((entry) => {
    if (!entry) {
      throw new Error(
        "Unsupported GitHub Actions trigger syntax: empty flow-style trigger entry",
      );
    }

    if (isList) {
      const name = unquoteYamlScalar(entry);
      if (
        inlineYamlColonIndex(entry) !== -1 ||
        entry.trim().startsWith("{") ||
        !/^[A-Za-z][\w-]*$/.test(name)
      ) {
        throw new Error(
          "Unsupported GitHub Actions trigger syntax: trigger lists must contain only event names",
        );
      }
      return triggerSection(name);
    }

    const colonIndex = inlineYamlColonIndex(entry);
    if (colonIndex === -1) {
      throw new Error(
        "Unsupported GitHub Actions trigger syntax: flow-style trigger maps require an event name and value",
      );
    }

    const name = unquoteYamlScalar(entry.slice(0, colonIndex));
    if (!/^[A-Za-z][\w-]*$/.test(name)) {
      throw new Error(
        "Unsupported GitHub Actions trigger syntax: flow-style trigger maps require valid event names",
      );
    }

    return triggerSection(name, entry.slice(colonIndex + 1).trim());
  });
}

function workflowTriggerRepresentation(workflow) {
  const onHeader = workflow
    .split(/\r?\n/)
    .find((line) => /^["']?on["']?\s*:\s*/.test(line));
  const inlineValue = onHeader?.match(/^["']?on["']?\s*:\s*(.*)$/)?.[1];
  const trimmedValue = inlineValue ? stripInlineComment(inlineValue) : "";

  if (!trimmedValue) {
    return "multiline trigger value";
  }

  const style = /^[\[{]/.test(trimmedValue)
    ? "flow-style"
    : /^[|>][+-]?$/.test(trimmedValue)
      ? "multiline"
      : "inline";
  return `${style} trigger value "on: ${trimmedValue}"`;
}

function workflowTriggerSections(workflow) {
  const lines = workflow.split(/\r?\n/);
  const onHeaders = lines.reduce((matches, line, index) => {
    const match = line.match(/^["']?on["']?\s*:\s*(.*)$/);
    if (match) {
      matches.push({ index, inlineValue: match[1] });
    }
    return matches;
  }, []);

  if (onHeaders.length > 1) {
    throw new Error(
      'Unsupported GitHub Actions trigger syntax: duplicate top-level "on" declarations',
    );
  }
  if (onHeaders.length === 0) {
    return [];
  }

  const { index: onHeaderIndex, inlineValue: onInlineValue } = onHeaders[0];
  if (stripInlineComment(onInlineValue)) {
    return inlineTriggerSections(onInlineValue);
  }

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

function workflowTriggerPathFilter(section, filterName) {
  if (!section) {
    return { configured: false, paths: [] };
  }

  const pathsHeaderIndex = section.lines.findIndex((line) =>
    new RegExp(`^ {4}(["']?)${filterName}\\1\\s*:`).test(line),
  );
  if (pathsHeaderIndex !== -1) {
    const pathsHeader = section.lines[pathsHeaderIndex];
    const inlineValue = pathsHeader.replace(
      new RegExp(`^(?:.*?["']?${filterName}["']?\\s*:\\s*)`),
      "",
    );
    if (stripInlineComment(inlineValue)) {
      const value = stripInlineComment(inlineValue);
      if (value.startsWith("[") && value.endsWith("]")) {
        return {
          configured: true,
          paths: splitInlineYaml(value.slice(1, -1)).map(
            (entry) => unquoteYamlScalar(entry),
          ),
        };
      }
      return { configured: true, paths: [unquoteYamlScalar(value)] };
    }

    const paths = [];
    for (const line of section.lines.slice(pathsHeaderIndex + 1)) {
      if (/^ {6}-\s*/.test(line)) {
        paths.push(unquoteYamlScalar(line.replace(/^ {6}-\s*/, "")));
        continue;
      }
      if (line.trim() !== "" && !/^\s*#/.test(line)) {
        break;
      }
    }
    return { configured: true, paths };
  }

  const inlineValue = stripInlineComment(section.inlineValue);
  const inlinePathsMatch = inlineValue.match(
    new RegExp(
      `(?:^\\{?\\s*|,\\s*)(["']?)${filterName}\\1\\s*:\\s*(\\[[^\\]]*\\]|[^,}]+)`,
    ),
  );
  if (!inlinePathsMatch) {
    return { configured: false, paths: [] };
  }

  const value = inlinePathsMatch[2].trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return {
      configured: true,
      paths: splitInlineYaml(value.slice(1, -1)).map((entry) =>
        unquoteYamlScalar(entry),
      ),
    };
  }
  return { configured: true, paths: [unquoteYamlScalar(value)] };
}

function workflowTriggerPaths(section) {
  return workflowTriggerPathFilter(section, "paths");
}

function workflowTriggerPathsIgnore(section) {
  return workflowTriggerPathFilter(section, "paths-ignore");
}

function pathFilterPattern(pattern, { allowNegation }) {
  let value = pattern;
  let negated = false;
  if (pattern.startsWith("!(")) {
    throw new Error("extglob operators are not supported");
  }
  if (value.startsWith("!")) {
    if (!allowNegation) {
      throw new Error("leading negation is only supported in paths filters");
    }
    negated = true;
    value = value.slice(1);
  }
  if (value.startsWith("./")) {
    value = value.slice(2);
  }
  if (value === "") {
    throw new Error("the pattern is empty");
  }

  const tokens = [];
  const escapeRegex = (character) =>
    character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      const escaped = value[index + 1];
      if (!escaped) {
        throw new Error("the pattern ends with an incomplete escape");
      }
      tokens.push({ source: escapeRegex(escaped), repeatable: true });
      index += 1;
      continue;
    }
    if (character === "*") {
      if (value[index + 1] === "*") {
        if (value[index + 2] === "/") {
          tokens.push({ source: "(?:.*/)?", repeatable: false });
          index += 2;
        } else {
          tokens.push({ source: ".*", repeatable: false });
          index += 1;
        }
      } else {
        tokens.push({ source: "[^/]*", repeatable: false });
      }
      continue;
    }
    if (character === "?") {
      tokens.push({ source: "[^/]", repeatable: true });
      continue;
    }
    if (character === "+") {
      const previous = tokens.at(-1);
      if (!previous?.repeatable) {
        throw new Error(
          "the + operator must follow a single-character or character-class pattern",
        );
      }
      previous.source = `(?:${previous.source})+`;
      previous.repeatable = false;
      continue;
    }
    if (character === "[") {
      const closingIndex = value.indexOf("]", index + 1);
      if (closingIndex === -1) {
        throw new Error("the character class is missing a closing ]");
      }
      let characters = value.slice(index + 1, closingIndex);
      if (characters.startsWith("!")) {
        characters = `^${characters.slice(1)}`;
      }
      if (characters === "" || characters === "^") {
        throw new Error("the character class is empty");
      }
      const characterClass = `[${characters.replace(/\\/gu, "\\\\")}]`;
      try {
        new RegExp(characterClass, "u");
      } catch {
        throw new Error("the character class is malformed");
      }
      tokens.push({
        source: `(?:(?!/)${characterClass})`,
        repeatable: true,
      });
      index = closingIndex;
      continue;
    }
    if (character === "]") {
      throw new Error("the pattern contains an unmatched ]");
    }
    if (character === "{" || character === "}") {
      throw new Error("brace expansion is not supported");
    }
    if (character === "(" && index > 0 && "@?*+!".includes(value[index - 1])) {
      throw new Error("extglob operators are not supported");
    }
    tokens.push({ source: escapeRegex(character), repeatable: true });
  }

  let regex;
  try {
    regex = new RegExp(`^${tokens.map(({ source }) => source).join("")}$`, "u");
  } catch {
    throw new Error("the pattern contains invalid glob syntax");
  }
  return {
    negated,
    matches(relativePath) {
      return regex.test(relativePath);
    },
  };
}

function pathFilterIncludesPath(patterns, relativePath) {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.matches(relativePath)) {
      included = !pattern.negated;
    }
  }
  return included;
}

export function checkNodeVersionFileTriggerCoverage({
  workflows,
  nodeVersionFileTargets = {},
  nodeVersionFileDependencies = {},
}) {
  const problems = [];

  function compilePathFilters(paths, workflowName, triggerName, filterName) {
    const patterns = [];
    let invalid = false;
    for (const pattern of paths) {
      try {
        patterns.push(pathFilterPattern(pattern, {
          allowNegation: filterName === "paths",
        }));
      } catch (error) {
        invalid = true;
        problems.push(
          `.github/workflows/${workflowName} ${triggerName}.${filterName} contains unsupported path filter pattern "${pattern}": ${error instanceof Error ? error.message : "invalid pattern"}`,
        );
      }
    }
    // Do not infer coverage from a partially compiled filter list.
    return invalid ? undefined : patterns;
  }

  for (const [workflowName, workflow] of Object.entries(workflows ?? {})) {
    if (typeof workflow !== "string") {
      continue;
    }

    const references = [...new Set(nodeVersionFilePaths(workflow).flatMap(
      (reference) => Object.hasOwn(nodeVersionFileTargets, reference)
        ? [reference, nodeVersionFileTargets[reference], ...(nodeVersionFileDependencies[reference] ?? [])]
        : [reference],
    ))];
    if (references.length === 0) {
      continue;
    }

    let sections;
    try {
      sections = workflowTriggerSections(workflow);
    } catch (error) {
      problems.push(
        `.github/workflows/${workflowName} has invalid trigger syntax in ${workflowTriggerRepresentation(workflow)}: ${error instanceof Error ? error.message.replace(/^Unsupported GitHub Actions trigger syntax:\s*/, "") : "unable to parse the trigger declaration"}`,
      );
      continue;
    }
    for (const triggerName of ["pull_request", "push", "pull_request_target"]) {
      const section = sections.find(({ name }) => name === triggerName);
      if (!section && triggerName === "pull_request_target") {
        continue;
      }
      const triggerPaths = workflowTriggerPaths(section);
      const triggerPathsIgnore = workflowTriggerPathsIgnore(section);
      if (!section) {
        problems.push(
          `.github/workflows/${workflowName} uses node-version-file but does not declare a ${triggerName} trigger`,
        );
        continue;
      }

      if (triggerPaths.configured) {
        const patterns = compilePathFilters(
          triggerPaths.paths, workflowName, triggerName, "paths",
        );
        for (const reference of references) {
          if (patterns && !pathFilterIncludesPath(patterns, reference)) {
            problems.push(
              `.github/workflows/${workflowName} ${triggerName}.paths must include "${reference}" because it is referenced by node-version-file`,
            );
          }
        }
      }

      if (triggerPathsIgnore.configured) {
        const patterns = compilePathFilters(
          triggerPathsIgnore.paths, workflowName, triggerName, "paths-ignore",
        );
        for (const reference of references) {
          if (patterns?.some(({ matches }) => matches(reference))) {
            problems.push(
              `.github/workflows/${workflowName} ${triggerName}.paths-ignore must not exclude "${reference}" because it is referenced by node-version-file`,
            );
          }
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "Node version file trigger coverage has drifted.",
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }

  return { workflows: Object.keys(workflows ?? {}).sort() };
}

function commandIncludesFlag(command, flag) {
  return typeof command === "string" && command.split(/\s+/).includes(flag);
}

const requiredStandardRecoveryCommands = Object.freeze([
  Object.freeze({
    script: "check:api-typecheck-rebuilds-libs:interruption",
    flag: "--test-interrupted-recovery",
  }),
  Object.freeze({
    script: "check:api-typecheck-rebuilds-libs:lock-handoff",
    flag: "--test-recovery-lock-handoff",
  }),
  Object.freeze({
    script: "check:api-typecheck-rebuilds-libs:lock-cleanup",
    flag: "--test-recovery-lock-cleanup",
  }),
  Object.freeze({
    script: "check:api-typecheck-rebuilds-libs:lock-rescan-failure",
    flag: "--test-recovery-lock-rescan-failure",
  }),
  Object.freeze({
    script: "check:api-typecheck-rebuilds-libs:lock-multi-rescan-failure",
    flag: "--test-recovery-lock-multi-rescan-failure",
  }),
]);

export function checkStandardRecoveryCommandContract({ packageJson }) {
  const packageScripts = packageJson?.scripts ?? {};
  const aggregateScript = "check:api-typecheck-rebuilds-libs:recovery";
  const aggregateCommand = packageScripts[aggregateScript];
  const problems = [];

  for (const { script, flag } of requiredStandardRecoveryCommands) {
    const focusedCommand = packageScripts[script];
    if (
      typeof focusedCommand !== "string" ||
      !focusedCommand.includes("scripts/check-api-typecheck-rebuilds-db.mjs") ||
      !commandIncludesFlag(focusedCommand, flag)
    ) {
      problems.push(
        `- Missing independently runnable package command ${script} for ${flag}`,
      );
    }

    if (
      typeof aggregateCommand !== "string" ||
      !aggregateCommand
        .split(/\s*&&\s*/)
        .includes(`pnpm run ${script}`)
    ) {
      problems.push(`- ${aggregateScript} must run ${script}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "Standard API typecheck recovery commands have drifted.",
        ...problems,
      ].join("\n"),
    );
  }

  return {
    scripts: requiredStandardRecoveryCommands.map(({ script }) => script),
  };
}

export function checkRecoveryRegressionCommandCoverage({
  packageJson,
  apiTypecheckHarnessSource,
}) {
  if (typeof apiTypecheckHarnessSource !== "string") {
    throw new Error("Missing API typecheck recovery regression harness source");
  }

  const regressionFlags = [
    ...new Set(
      [
        ...apiTypecheckHarnessSource.matchAll(
          /process\.argv\.includes\(\s*["'](--test-[a-z0-9-]+)["']\s*,?\s*\)/g,
        ),
      ].map((match) => match[1]),
    ),
  ].sort();
  const packageScripts = packageJson?.scripts ?? {};
  const missingFlags = regressionFlags.filter(
    (flag) =>
      !Object.values(packageScripts).some(
        (command) =>
          typeof command === "string" &&
          command.includes("scripts/check-api-typecheck-rebuilds-db.mjs") &&
          commandIncludesFlag(command, flag),
      ),
  );

  if (missingFlags.length > 0) {
    throw new Error(
      [
        "API typecheck recovery regression commands have drifted.",
        "Every --test-* recovery flag must have a package.json validation command.",
        ...missingFlags.map(
          (flag) => `- Missing package.json command for ${flag}`,
        ),
      ].join("\n"),
    );
  }

  return { flags: regressionFlags };
}

function sectionHasMainBranch(section) {
  const branchesHeaderIndex = section.lines.findIndex((line) =>
    /^ {4}(["']?)branches\1\s*:/.test(line),
  );

  const branchesHeader =
    branchesHeaderIndex === -1
      ? section.inlineValue
      : section.lines[branchesHeaderIndex];
  const inlineValue = branchesHeader.replace(
    /^(?:.*?["']?branches["']?\s*:\s*)/,
    "",
  );
  if (/(?:^|\[|,|\{)\s*["']?main["']?\s*(?:,|\]|\}|$)/.test(inlineValue)) {
    return true;
  }

  if (branchesHeaderIndex === -1) {
    return false;
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
        (section.inlineValue.match(/["']?cron["']?\s*:/g) ?? []).length +
        section.lines.filter((line) =>
          /^\s*-\s*(?:\{\s*)?["']?cron["']?\s*:/.test(line),
        ).length,
      0,
    );
}

function nativeProcessMatrixEntries(workflow) {
  const lines = workflow.split(/\r?\n/);
  const matrixHeader = lines.findIndex((line) =>
    /^\s*matrix:\s*(?:#.*)?$/.test(line),
  );
  if (matrixHeader === -1) {
    return [];
  }

  const matrixIndent = lines[matrixHeader].search(/\S|$/);
  const includeHeader = lines.findIndex(
    (line, index) =>
      index > matrixHeader &&
      line.search(/\S|$/) > matrixIndent &&
      /^\s*include:\s*(?:#.*)?$/.test(line),
  );
  if (includeHeader === -1) {
    return [];
  }

  const includeIndent = lines[includeHeader].search(/\S|$/);
  const entries = [];
  for (let index = includeHeader + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const indentation = line.search(/\S|$/);

    if (trimmed !== "" && indentation <= matrixIndent) {
      break;
    }

    const itemMatch = line.match(/^(\s*)-\s+(.*?)\s*(?:#.*)?$/);
    if (!itemMatch || itemMatch[1].length <= includeIndent) {
      continue;
    }

    const entry = {
      host: undefined,
      os: undefined,
      node: undefined,
    };
    const itemIndent = itemMatch[1].length;
    const firstFieldMatch = itemMatch[2].match(
      /^(host|os|node):\s*(.*?)\s*$/,
    );
    if (firstFieldMatch) {
      entry[firstFieldMatch[1]] =
        firstFieldMatch[1] === "node"
          ? (parseNumericNodeVersion(firstFieldMatch[2]) ??
            unquoteYamlScalar(firstFieldMatch[2]))
          : unquoteYamlScalar(firstFieldMatch[2]);
    }

    for (
      let fieldIndex = index + 1;
      fieldIndex < lines.length;
      fieldIndex += 1
    ) {
      const fieldLine = lines[fieldIndex];
      const fieldTrimmed = fieldLine.trim();
      const fieldIndentation = fieldLine.search(/\S|$/);
      if (
        fieldTrimmed !== "" &&
        (fieldIndentation <= itemIndent || fieldIndentation <= matrixIndent)
      ) {
        break;
      }

      const fieldMatch = fieldLine.match(
        /^\s+(host|os|node):\s*(.*?)\s*(?:#.*)?$/,
      );
      if (!fieldMatch) {
        continue;
      }
      entry[fieldMatch[1]] =
        fieldMatch[1] === "node"
          ? (parseNumericNodeVersion(fieldMatch[2]) ??
            unquoteYamlScalar(fieldMatch[2]))
          : unquoteYamlScalar(fieldMatch[2]);
    }

    entries.push(entry);
  }

  return entries;
}

function nativeProcessMatrixEntryLabel(entry) {
  return `${entry.host} on ${entry.os} with Node.js ${entry.node}`;
}

function nativeProcessMatrixEntryValue(value) {
  return value === undefined || value === "" ? "<missing>" : String(value);
}

function nativeProcessMatrixEntryContext(entry) {
  return `host: ${nativeProcessMatrixEntryValue(entry.host)}, runner: ${nativeProcessMatrixEntryValue(entry.os)}, Node: ${nativeProcessMatrixEntryValue(entry.node)}`;
}

function workflowStepBlocks(workflow) {
  const lines = workflow.split(/\r?\n/);
  const stepStarts = lines.reduce((starts, line, index) => {
    if (/^(\s*)-\s+(?:name|uses|run):/.test(line)) {
      starts.push(index);
    }
    return starts;
  }, []);

  return stepStarts.map((start, index) => {
    const stepIndent = lines[start].search(/\S|$/);
    const end = stepStarts
      .slice(index + 1)
      .find((candidate) => lines[candidate].search(/\S|$/) === stepIndent);
    return lines.slice(start, end ?? lines.length).join("\n");
  });
}

function workflowJobBlocks(workflow) {
  const lines = workflow.split(/\r?\n/);
  const jobsHeaderIndex = lines.findIndex((line) =>
    /^\s*(?:jobs|"jobs"|'jobs'):\s*(?:#.*)?$/.test(line),
  );
  if (jobsHeaderIndex === -1) {
    return [];
  }

  const jobsIndent = lines[jobsHeaderIndex].search(/\S|$/);
  const jobIndent = lines
    .slice(jobsHeaderIndex + 1)
    .find((line) => {
      const indentation = line.search(/\S|$/);
      return (
        line.trim() !== "" &&
        indentation > jobsIndent &&
        /^\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_.-]+):\s*/.test(line)
      );
    })
    ?.search(/\S|$/);
  if (jobIndent === undefined) {
    return [];
  }

  const jobStarts = [];
  for (let index = jobsHeaderIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indentation = line.search(/\S|$/);
    if (line.trim() !== "" && indentation <= jobsIndent) {
      break;
    }
    if (indentation !== jobIndent) {
      continue;
    }
    const jobMatch = line.match(
      /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+)):\s*/,
    );
    if (jobMatch) {
      jobStarts.push({
        index,
        name: jobMatch[1] ?? jobMatch[2] ?? jobMatch[3],
      });
    }
  }

  return jobStarts.map(({ index, name }, jobIndex) => {
    const end = jobStarts[jobIndex + 1]?.index ?? lines.length;
    return { name, workflow: lines.slice(index, end).join("\n") };
  });
}

// Read only direct mapping properties: nested env/with keys and shell text
// must not be mistaken for the job or step's execution guard.
function directGuard(lines, indent) {
  const index = lines.findIndex((line) =>
    line.search(/\S|$/) === indent && /^\s*(?:if|"if"|'if'):\s*/.test(line),
  );
  if (index === -1) return undefined;
  const value = lines[index].replace(/^\s*(?:if|"if"|'if'):\s*/, "");
  if (!/^[|>][+-]?\s*(?:#.*)?$/.test(value)) {
    return unquoteYamlScalar(value);
  }
  const continuation = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && line.search(/\S|$/) <= indent) break;
    continuation.push(stripInlineComment(line));
  }
  return continuation.join(" ").trim();
}

function guardPreservesNodeCoverage(guard) {
  if (guard === undefined) return true;
  // Bound input work as well as recursive grouping depth. This is a small
  // grammar recognizer, not an Actions expression evaluator.
  if (guard.length > 4096) return false;
  const expression = guard.replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  const tokenPattern = /\s*(true\b|always\s*\(\s*\)|success\s*\(\s*\)|!\s*cancelled\s*\(\s*\)|&&|\|\||[()])/iy;
  const tokens = [];
  let offset = 0;
  while (offset < expression.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(expression);
    if (!match || tokens.length >= 512) return false;
    tokens.push(match[1]);
    offset = tokenPattern.lastIndex;
  }

  let cursor = 0;
  function primary(depth) {
    if (tokens[cursor] === "(") {
      if (depth >= 32) return false;
      cursor += 1;
      if (!disjunction(depth + 1) || tokens[cursor] !== ")") return false;
      cursor += 1;
      return true;
    }
    const token = tokens[cursor];
    if (!token || ["&&", "||", ")"].includes(token)) return false;
    cursor += 1;
    return true;
  }
  function conjunction(depth) {
    if (!primary(depth)) return false;
    while (tokens[cursor] === "&&") {
      cursor += 1;
      if (!primary(depth)) return false;
    }
    return true;
  }
  function disjunction(depth) {
    if (!conjunction(depth)) return false;
    while (tokens[cursor] === "||") {
      cursor += 1;
      if (!conjunction(depth)) return false;
    }
    return true;
  }
  // Every operand must be a previously accepted safe atom. In particular,
  // do not short-circuit away unknown changed-path or event restrictions.
  return disjunction(0) && cursor === tokens.length;
}

function nodeGuardJobDetails(job) {
      const lines = job.workflow.split(/\r?\n/);
      const propertyIndent = lines.find((line, index) =>
        index > 0 && line.trim() && !line.trimStart().startsWith("#"),
      )?.search(/\S|$/);
      const stepsHeader = lines.findIndex((line) =>
        line.search(/\S|$/) === propertyIndent && /^\s*(?:steps|"steps"|'steps'):\s*(?:#.*)?$/.test(line),
      );
      if (stepsHeader === -1) return { lines, propertyIndent, setupSteps: [] };
      let end = stepsHeader + 1;
      while (end < lines.length) {
        const line = lines[end];
        if (line.trim() && !line.trimStart().startsWith("#") &&
            line.search(/\S|$/) <= propertyIndent && !/^\s*-\s/.test(line)) break;
        end += 1;
      }
      const stepLines = lines.slice(stepsHeader + 1, end);
      const stepIndent = stepLines.find((line) => /^\s*-\s/.test(line))?.search(/\S|$/);
      const starts = stepLines.flatMap((line, index) =>
        line.search(/\S|$/) === stepIndent && /^\s*-\s/.test(line) ? [index] : [],
      );
      const setupSteps = starts.flatMap((start, index) => {
        const block = stepLines.slice(start, starts[index + 1]);
        block[0] = block[0].replace("- ", "  ");
        const uses = block.find((line) =>
          line.search(/\S|$/) === stepIndent + 2 && /^\s*(?:uses|"uses"|'uses'):/.test(line),
        );
        if (!uses || !/^actions\/setup-node@/i.test(
          unquoteYamlScalar(uses.replace(/^\s*(?:uses|"uses"|'uses'):\s*/, "")),
        )) return [];
        const label = block.find((line) =>
          line.search(/\S|$/) === stepIndent + 2 && /^\s*(?:id|name|"id"|"name"|'id'|'name'):/.test(line),
        );
        return [{
          label: label ? unquoteYamlScalar(label.replace(/^\s*(?:id|name|"id"|"name"|'id'|'name'):\s*/, "")) : `#${index + 1} (actions/setup-node)`,
          guard: directGuard(block, stepIndent + 2),
        }];
      });
      return { lines, propertyIndent, setupSteps };
}

export function checkNodeCompatibilityGuardCoverage({ workflows }) {
  const problems = [];
  for (const [workflowName, workflow] of Object.entries(workflows ?? {})) {
    if (typeof workflow !== "string") continue;
    for (const job of workflowJobBlocks(workflow)) {
      const { lines, propertyIndent, setupSteps } = nodeGuardJobDetails(job);
      if (setupSteps.length === 0) continue;
      const context = `.github/workflows/${workflowName} job "${job.name}"`;
      if (!guardPreservesNodeCoverage(directGuard(lines, propertyIndent))) {
        problems.push(`${context}: job if guard may skip Node compatibility checks after a version-file change`);
      }
      for (const step of setupSteps) {
        if (!guardPreservesNodeCoverage(step.guard)) {
          problems.push(`${context} step "${step.label}": setup if guard may skip Node compatibility checks after a version-file change`);
        }
      }
    }
  }
  if (problems.length) {
    throw new Error([
      "Node compatibility guard coverage is incomplete.",
      ...problems,
      "Use no if guard, true, success(), always(), or !cancelled() on Node setup steps and their jobs, optionally combined with parentheses, &&, or || (up to 4096 characters, 512 tokens, and 32 grouping levels); other expressions cannot be proven to cover version-file changes.",
    ].join("\n"));
  }
}

// Only job-level local calls participate. Remote workflows are deliberately
// opaque: never fetch another repository or interpret an Actions expression.
export function checkLocalReusableNodeGuardCoverage({ workflows }) {
  const jobs = new Map(Object.entries(workflows ?? {})
    .filter(([, contents]) => typeof contents === "string")
    .map(([name, contents]) => [name, workflowJobBlocks(contents).map((job) => {
      const details = nodeGuardJobDetails(job);
      const usesLine = details.lines.find((line) =>
        line.search(/\S|$/) === details.propertyIndent &&
        /^\s*(?:uses|"uses"|'uses'):\s*/.test(line),
      );
      const uses = usesLine === undefined ? undefined : unquoteYamlScalar(
        usesLine.replace(/^\s*(?:uses|"uses"|'uses'):\s*/, ""),
      );
      return { ...job, ...details, uses };
    })]));
  const problems = [];
  const isLocal = (uses) => typeof uses === "string" && uses.startsWith("./");
  const localTarget = (uses) => {
    const match = /^\.\/\.github\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)$/.exec(uses);
    if (!match) throw new Error(`unsupported repository-local workflow reference "${uses}"`);
    if (!jobs.has(match[1])) throw new Error(`missing local workflow "${uses}"`);
    return match[1];
  };

  for (const [name, workflowJobs] of jobs) {
    for (const caller of workflowJobs) {
      if (!isLocal(caller.uses)) continue;
      const context = `.github/workflows/${name} job "${caller.name}" calling ${caller.uses}`;
      const memo = new Map();
      const active = new Set([name]);
      let visits = 0;
      function containsNode(target, chain) {
        if (active.has(target)) throw new Error(`local workflow cycle: ${[...chain, target].join(" -> ")}`);
        if (chain.length >= 32) throw new Error(`local workflow traversal exceeds 32 levels: ${chain.join(" -> ")}`);
        if (memo.has(target)) {
          const cached = memo.get(target);
          if (chain.length + cached.height > 32) {
            throw new Error(`local workflow traversal exceeds 32 levels: ${[...chain, target].join(" -> ")}`);
          }
          return cached;
        }
        if (++visits > 512) throw new Error("local workflow traversal exceeds 512 workflows");
        active.add(target);
        let found = false;
        let height = 1;
        for (const job of jobs.get(target)) {
          found = job.setupSteps.length > 0 || found;
          if (isLocal(job.uses)) {
            // Do not short-circuit: a second branch can contain a broken call.
            const child = containsNode(localTarget(job.uses), [...chain, target]);
            found = child.found || found;
            height = Math.max(height, child.height + 1);
          }
        }
        active.delete(target);
        const result = { found, height };
        memo.set(target, result);
        return result;
      }
      try {
        if (containsNode(localTarget(caller.uses), [name]).found &&
            !guardPreservesNodeCoverage(directGuard(caller.lines, caller.propertyIndent))) {
          problems.push(`${context}: caller if guard may skip delegated Node compatibility checks after a version-file change`);
        }
      } catch (error) {
        problems.push(`${context}: ${error.message}`);
      }
    }
  }
  if (problems.length) {
    throw new Error([
      "Local reusable-workflow Node guard coverage is incomplete.",
      ...problems,
      "Local calls that reach actions/setup-node must use version-change-safe caller guards; references must resolve within .github/workflows without cycles (at most 32 levels and 512 workflows per call).",
    ].join("\n"));
  }
}

function hasScheduledFailureCondition(step) {
  const ifValue = step.match(/^\s*if:\s*(.*?)\s*$/m)?.[1] ?? "";
  return (
    /failure\(\)/.test(ifValue) &&
    /github\.event_name\s*==\s*['"]schedule['"]/.test(ifValue)
  );
}

function hasYamlValue(step, key, value) {
  return new RegExp(`^\\s*${key}:\\s*${value}\\s*$`, "m").test(step);
}

function hasYamlKey(step, key) {
  return new RegExp(`^\\s*${key}:\\s*\\S.*$`, "m").test(step);
}

function hasMatrixValueInArtifactName(step, matrixKey) {
  const artifactName = step.match(/^\s*name:\s*(.*?)\s*$/m)?.[1] ?? "";
  return new RegExp(
    `\\$\\{\\{[^}]*\\bmatrix\\.${matrixKey}\\b[^}]*\\}\\}`,
  ).test(artifactName);
}

export function nativeProcessDiagnosticArtifactNames({
  workflow,
  matrixEntries = requiredNativeProcessMatrixEntries,
}) {
  const diagnosticsUploadStep = workflowStepBlocks(workflow).find((step) =>
    step.includes("uses: actions/upload-artifact@v4") &&
    stepId(step) !== "native-process-identity-recovery-upload",
  );
  const artifactName =
    diagnosticsUploadStep?.match(/^\s*name:\s*(.*?)\s*$/m)?.[1] ?? "";

  return matrixEntries.map((entry) => ({
    entry,
    name: artifactName.replace(
      /\$\{\{\s*matrix\.(os|node)\s*\}\}/g,
      (_, matrixKey) => String(entry[matrixKey]),
    ),
  }));
}

function hasFinitePositiveIntegerYamlValue(step, key) {
  return new RegExp(`^\\s*${key}:\\s*[1-9]\\d*\\s*(?:#.*)?$`, "m").test(step);
}

function stepRunCommand(step) {
  const command = step.match(/^\s*run:\s*(.*?)\s*$/m)?.[1]?.trim();
  // Permit only the CI report suffix, not arbitrary extra shell commands/flags.
  return command?.replace(
    / --failure-report "\$\{\{ env\.API_TYPECHECK_FAILURE_REPORT_DIR \}\}\/[a-z0-9-]+\.json"$/,
    "",
  );
}

function stepId(step) {
  return step.match(/^\s*id:\s*([a-zA-Z0-9_-]+)\s*$/m)?.[1];
}

function stepEnvironmentValue(step, key) {
  const lines = step.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) =>
    new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`).test(line),
  );
  if (keyIndex === -1) {
    return "";
  }
  const keyIndent = lines[keyIndex].search(/\S|$/);
  const inlineValue = lines[keyIndex].replace(
    new RegExp(`^\\s*${key}:\\s*`),
    "",
  );
  if (inlineValue && !/^[>|][+-]?$/.test(inlineValue)) {
    return inlineValue;
  }
  const valueLines = [];
  for (const line of lines.slice(keyIndex + 1)) {
    if (line.trim() !== "" && line.search(/\S|$/) <= keyIndent) {
      break;
    }
    valueLines.push(line);
  }
  return valueLines.join("\n");
}

function stepUsesAction(step) {
  return step.match(/^\s*(?:-\s+)?uses:\s*([^\r\n]*?)\s*$/m)?.[1]?.trim();
}

function scheduledArtifactUploadProblems({ workflows, parsedTriggerSections }) {
  const problems = [];

  for (const [workflowName, workflow] of Object.entries(workflows ?? {})) {
    if (typeof workflow !== "string") {
      continue;
    }

    const sections = parsedTriggerSections.get(workflowName) ?? [];
    if (scheduleEntryCount(sections) === 0) {
      continue;
    }

    const uploadSteps = workflowStepBlocks(workflow).filter((step) =>
      stepUsesAction(step)?.startsWith("actions/upload-artifact@"),
    );
    for (const [index, uploadStep] of uploadSteps.entries()) {
      const uploadLabel =
        uploadStep.match(/^\s*(?:-\s+)?name:\s*(.*?)\s*$/m)?.[1] ??
        `upload step ${index + 1}`;
      const context = `.github/workflows/${workflowName} ${uploadLabel}`;

      if (!hasYamlKey(uploadStep, "retention-days")) {
        problems.push(
          `${context} scheduled artifact upload must set an explicit retention-days value`,
        );
      } else if (
        !hasFinitePositiveIntegerYamlValue(uploadStep, "retention-days")
      ) {
        problems.push(
          `${context} scheduled artifact upload retention-days must be a finite positive integer`,
        );
      }
    }
  }

  return problems;
}

function hasMatrixNodeVersion(step) {
  return /^\s*node-version:\s*\$\{\{\s*matrix\.node\s*\}\}\s*$/m.test(
    step,
  );
}

export function checkNativeProcessWorkflowStepOrder({ workflow }) {
  const problems = [];
  if (typeof workflow !== "string") {
    throw new Error(
      `Missing .github/workflows/${nativeProcessWorkflowName}; the native process workflow is required`,
    );
  }

  const jobs = workflowJobBlocks(workflow);
  if (jobs.length === 0) {
    problems.push("must define at least one native process workflow job");
  }

  for (const { name: jobName, workflow: jobWorkflow } of jobs) {
    const stepBlocks = workflowStepBlocks(jobWorkflow);
    const synchronizationStepIndex = stepBlocks.findIndex(
      (step) =>
        stepRunCommand(step) === nativeProcessNodeSupportSynchronizationCommand,
    );
    const nativeProbeStepIndexes = requiredNativeProcessProbeCommands
      .map((probeCommand) =>
        stepBlocks.findIndex((step) => stepRunCommand(step) === probeCommand),
      )
      .filter((stepIndex) => stepIndex !== -1);
    const hasNativeWork =
      synchronizationStepIndex !== -1 || nativeProbeStepIndexes.length > 0;

    if (!hasNativeWork) {
      continue;
    }

    for (const step of stepBlocks) {
      if (
        stepRunCommand(step) !==
        "pnpm run check:api-typecheck-rebuilds-libs:process-identity:native-transition-exit"
      ) {
        continue;
      }
      const iterations = unquoteYamlScalar(
        stepEnvironmentValue(step, "API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS").trim(),
      );
      // The probe accepts 1–10; CI must explicitly request repeated handoffs.
      if (!/^(?:[2-9]|10)$/.test(iterations)) {
        problems.push(
          `job "${jobName}" transition-lock owner-exit probe must explicitly set API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS to an integer between 2 and 10 in its step environment`,
        );
      }
    }

    const setupNodeStepIndexes = stepBlocks.reduce(
      (indexes, step, stepIndex) => {
        if (stepUsesAction(step)?.startsWith("actions/setup-node@")) {
          indexes.push(stepIndex);
        }
        return indexes;
      },
      [],
    );
    if (setupNodeStepIndexes.length > 1) {
      problems.push(
        `job "${jobName}" must declare only one actions/setup-node step; duplicate setup-node steps make the selected Node runtime ambiguous`,
      );
    }

    const regressionStepIndex = stepBlocks.findIndex(
      (step) =>
        stepRunCommand(step) === nativeProcessNodeSupportRegressionCommand,
    );
    if (regressionStepIndex === -1) {
      problems.push(
        `job "${jobName}" must run the Node support matrix regression test step (${nativeProcessNodeSupportRegressionCommand}) before its synchronization check and native probe steps`,
      );
    } else {
      if (
        synchronizationStepIndex !== -1 &&
        regressionStepIndex > synchronizationStepIndex
      ) {
        problems.push(
          `job "${jobName}" must run the Node support matrix regression test step (${nativeProcessNodeSupportRegressionCommand}) before the synchronization check (${nativeProcessNodeSupportSynchronizationCommand})`,
        );
      }

      for (const probeStepIndex of nativeProbeStepIndexes) {
        if (regressionStepIndex > probeStepIndex) {
          problems.push(
            `job "${jobName}" must run the Node support matrix regression test step (${nativeProcessNodeSupportRegressionCommand}) before native probe`,
          );
        }
      }
    }

    const setupNodeStepIndex = stepBlocks.findIndex(
      (step) => stepUsesAction(step) === "actions/setup-node@v4",
    );
    const setupNodeStep =
      setupNodeStepIndex === -1 ? undefined : stepBlocks[setupNodeStepIndex];
    if (
      nativeProbeStepIndexes.length > 0 &&
      (setupNodeStepIndex === -1 || !hasMatrixNodeVersion(setupNodeStep))
    ) {
      problems.push(
        `job "${jobName}" must configure actions/setup-node@v4 with node-version: \${{ matrix.node }} before native probe steps`,
      );
    } else if (setupNodeStepIndex !== -1) {
      for (const probeStepIndex of nativeProbeStepIndexes) {
        if (setupNodeStepIndex > probeStepIndex) {
          problems.push(
            `job "${jobName}" actions/setup-node@v4 step must run before native probe`,
          );
        }
      }
    }
  }

  const allStepBlocks = workflowStepBlocks(workflow);
  if (
    !allStepBlocks.some(
      (step) =>
        stepRunCommand(step) === nativeProcessNodeSupportSynchronizationCommand,
    )
  ) {
    problems.push(
      `must retain the Node support matrix synchronization check (${nativeProcessNodeSupportSynchronizationCommand})`,
    );
  }

  if (jobs.length === 0) {
    const stepBlocks = workflowStepBlocks(workflow);
    if (
      stepBlocks.some(
        (step) =>
          stepRunCommand(step) === nativeProcessNodeSupportRegressionCommand,
      )
    ) {
      problems.push(
        `the Node support matrix regression test step (${nativeProcessNodeSupportRegressionCommand}) cannot be associated with a native process workflow job`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "The native process workflow step-order contract has drifted.",
        `Workflow: .github/workflows/${nativeProcessWorkflowName}`,
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }

  return {
    workflow: nativeProcessWorkflowName,
    regression: nativeProcessNodeSupportRegressionCommand,
    synchronization: nativeProcessNodeSupportSynchronizationCommand,
    probes: requiredNativeProcessProbeCommands,
  };
}

export function checkNativeProcessWorkflowCoverage({ workflow }) {
  const problems = [];
  if (typeof workflow !== "string") {
    throw new Error(
      `Missing .github/workflows/${nativeProcessWorkflowName}; the native process workflow is required`,
    );
  }

  for (const triggerName of ["pull_request", "push"]) {
    const sections = workflowTriggerSections(workflow).filter(
      (section) => section.name === triggerName,
    );
    if (sections.length !== 1) {
      problems.push(`HTTP shutdown coverage requires one ${triggerName} trigger`);
      continue;
    }
    const included = workflowTriggerPaths(sections[0]);
    const ignored = workflowTriggerPathsIgnore(sections[0]);
    try {
      const includePatterns = included.paths.map((pattern) =>
        pathFilterPattern(pattern, { allowNegation: true }),
      );
      const ignorePatterns = ignored.paths.map((pattern) =>
        pathFilterPattern(pattern, { allowNegation: false }),
      );
      for (const source of [...httpShutdownTriggerPaths, nativeInterruptionTestFile]) {
        if (
          (included.configured && !pathFilterIncludesPath(includePatterns, source)) ||
          ignorePatterns.some((pattern) => pattern.matches(source))
        ) {
          const coverage = source === nativeInterruptionTestFile ? "interrupted owner cleanup" : "HTTP shutdown";
          problems.push(`${triggerName} must trigger ${coverage} coverage for "${source}"`);
        }
      }
    } catch (error) {
      problems.push(`${triggerName} HTTP shutdown path filters are invalid: ${error.message}`);
    }
  }

  const interruptionMatrixEntries = [];
  for (const job of workflowJobBlocks(workflow)) {
    const steps = workflowStepBlocks(job.workflow);
    const header = job.workflow.split(/^\s*steps:\s*$/m)[0];
    const setupIndex = steps.findIndex(
      (step) => stepUsesAction(step) === "actions/setup-node@v4" && hasMatrixNodeVersion(step),
    );
    if (
      hasYamlKey(header, "if") || hasYamlKey(header, "continue-on-error") ||
      !/^\s*runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}\s*$/m.test(header) ||
      setupIndex === -1 || hasYamlKey(steps[setupIndex], "if") ||
      hasYamlKey(steps[setupIndex], "continue-on-error")
    ) continue;
    if (steps.some((step, index) =>
      index > setupIndex && stepRunCommand(step) === nativeInterruptionTestCommand &&
      !hasYamlKey(step, "if") && !hasYamlKey(step, "continue-on-error"),
    )) interruptionMatrixEntries.push(...nativeProcessMatrixEntries(job.workflow));
  }
  for (const required of requiredNativeProcessMatrixEntries) {
    if (!interruptionMatrixEntries.some((entry) =>
      entry.host === required.host && entry.os === required.os && entry.node === required.node,
    )) {
      problems.push(
        `must run interrupted owner cleanup (${nativeInterruptionTestCommand}) without conditions or tolerated failures after matrix Node setup on ${nativeProcessMatrixEntryLabel(required)}`,
      );
    }
  }

  const shutdownMatrixEntries = [];
  for (const job of workflowJobBlocks(workflow)) {
    const steps = workflowStepBlocks(job.workflow);
    const shutdownIndex = steps.findIndex(
      (step) => stepRunCommand(step) === httpShutdownTestCommand &&
        unquoteYamlScalar(stepEnvironmentValue(step, "API_TEST_FILE").trim()) === httpShutdownTestFile,
    );
    if (shutdownIndex === -1) continue;
    const header = job.workflow.split(/^\s*steps:\s*$/m)[0];
    const shutdownStep = steps[shutdownIndex];
    const setupIndex = steps.findIndex(
      (step) => stepUsesAction(step) === "actions/setup-node@v4" && hasMatrixNodeVersion(step),
    );
    if (
      hasYamlKey(header, "if") || hasYamlKey(shutdownStep, "if") ||
      hasYamlKey(header, "continue-on-error") || hasYamlKey(shutdownStep, "continue-on-error") ||
      !/^\s*runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}\s*$/m.test(header) ||
      setupIndex === -1 || setupIndex >= shutdownIndex
    ) continue;
    shutdownMatrixEntries.push(...nativeProcessMatrixEntries(job.workflow));
  }
  for (const required of requiredNativeProcessMatrixEntries) {
    if (!shutdownMatrixEntries.some((entry) =>
      entry.host === required.host && entry.os === required.os && entry.node === required.node,
    )) {
      problems.push(
        `must run the focused HTTP shutdown test (${httpShutdownTestCommand}, API_TEST_FILE: ${httpShutdownTestFile}) without conditions or tolerated failures after matrix Node setup on ${nativeProcessMatrixEntryLabel(required)}`,
      );
    }
  }

  const matrixEntries = nativeProcessMatrixEntries(workflow);
  const invalidMatrixEntries = matrixEntries.filter(
    (entry) =>
      !supportedNativeProcessMatrixHosts.has(entry.host) ||
      !supportedNativeProcessMatrixRunners.has(entry.os) ||
      !supportedNativeProcessMatrixNodes.has(entry.node) ||
      !supportedNativeProcessMatrixEntryKeys.has(
        `${entry.host}|${entry.os}|${String(entry.node)}`,
      ),
  );
  if (invalidMatrixEntries.length > 0) {
    problems.push(
      `native process matrix rows are incomplete or unsupported; they must use supported host, runner, and Node values: ${invalidMatrixEntries.map((entry) => nativeProcessMatrixEntryContext(entry)).join("; ")}`,
    );
  }
  const seenMatrixEntries = new Set();
  const duplicateMatrixEntries = [];
  for (const entry of matrixEntries) {
    if (
      typeof entry.host !== "string" ||
      typeof entry.os !== "string" ||
      typeof entry.node !== "number"
    ) {
      continue;
    }

    const key = `${entry.host}|${entry.os}|${String(entry.node)}`;
    if (seenMatrixEntries.has(key)) {
      duplicateMatrixEntries.push(entry);
    } else {
      seenMatrixEntries.add(key);
    }
  }
  if (duplicateMatrixEntries.length > 0) {
    problems.push(
      `must not duplicate native process matrix entries: ${duplicateMatrixEntries.map(nativeProcessMatrixEntryLabel).join(", ")}`,
    );
  }

  const actualMatrixEntries = new Set(
    matrixEntries.map(
      (entry) => `${entry.host}|${entry.os}|${String(entry.node)}`,
    ),
  );
  const missingMatrixEntries = requiredNativeProcessMatrixEntries.filter(
    (entry) =>
      !actualMatrixEntries.has(
        `${entry.host}|${entry.os}|${String(entry.node)}`,
      ),
  );
  if (missingMatrixEntries.length > 0) {
    problems.push(
      `must include matrix entries for ${missingMatrixEntries.map(nativeProcessMatrixEntryLabel).join(", ")}`,
    );
  }

  const missingProbeCommands = requiredNativeProcessProbeCommands.filter(
    (command) =>
      !workflowStepBlocks(workflow).some(
        (step) => stepRunCommand(step) === command,
      ),
  );
  if (missingProbeCommands.length > 0) {
    problems.push(
      `must retain required native probe steps: ${missingProbeCommands.join(", ")}`,
    );
  }

  const stepBlocks = workflowStepBlocks(workflow);
  const interruptedPublicationProbeStep = stepBlocks.find(
    (step) =>
      stepRunCommand(step) ===
      "pnpm run check:api-typecheck-rebuilds-libs:interrupted-publication",
  );
  if (
    interruptedPublicationProbeStep &&
    !/matrix\.os\s*==\s*['"]windows-latest['"]/.test(
      interruptedPublicationProbeStep,
    )
  ) {
    problems.push(
      "the interrupted publication recovery probe must run only on windows-latest matrix entries",
    );
  }
  if (interruptedPublicationProbeStep) {
    const crashPointDeclarations = [
      ...interruptedPublicationProbeStep.matchAll(
        /^\s*API_TYPECHECK_INTERRUPTED_PUBLICATION_CRASH_POINTS:\s*["']?([^"'\s]+)["']?\s*$/gm,
      ),
    ];
    if (crashPointDeclarations.length !== 1 ||
        crashPointDeclarations[0]?.[1] !== "staging,active,restore") {
      problems.push(
        "the interrupted publication recovery probe must require staging,active,restore crash points",
      );
    }
    const publicationRecoveryRunDeclarations = [
      ...interruptedPublicationProbeStep.matchAll(
        /^\s*API_TYPECHECK_INTERRUPTED_PUBLICATION_RUNS:\s*["']?(\d+)["']?\s*$/gm,
      ),
    ];
    if (
      publicationRecoveryRunDeclarations.length !== 1 ||
      Number(publicationRecoveryRunDeclarations[0]?.[1]) !==
        requiredInterruptedPublicationRecoveryRuns
    ) {
      problems.push(
        `the interrupted publication recovery probe must require exactly ${requiredInterruptedPublicationRecoveryRuns} isolated runs through API_TYPECHECK_INTERRUPTED_PUBLICATION_RUNS`,
      );
    }
  }
  const failureAttributionSteps = stepBlocks.filter(
    (step) => stepRunCommand(step) === nativeProcessFailureAttributionCommand,
  );
  const failureAttributionStep =
    failureAttributionSteps.length === 1
      ? failureAttributionSteps[0]
      : undefined;
  const failureAttributionStepIndex =
    failureAttributionSteps.length === 1
      ? stepBlocks.indexOf(failureAttributionStep)
      : -1;
  const diagnosticsCollectionSteps = stepBlocks.filter((step) =>
    step.includes("--collect-native-process-diagnostics"),
  );
  const diagnosticsCollectionStep =
    diagnosticsCollectionSteps.length === 1
      ? diagnosticsCollectionSteps[0]
      : undefined;
  const diagnosticsCollectionStepIndex =
    diagnosticsCollectionSteps.length === 1
      ? stepBlocks.indexOf(diagnosticsCollectionStep)
      : -1;
  const recoveryProbeStep = stepBlocks.find(
    (step) => stepId(step) === "native-process-identity-recovery",
  );
  if (failureAttributionSteps.length === 0) {
    problems.push(
      "must record native probe failure attribution before diagnostics collection using --record-native-process-probe-failure",
    );
  } else if (failureAttributionSteps.length > 1) {
    problems.push(
      `must contain exactly one native probe failure attribution step using --record-native-process-probe-failure; found ${failureAttributionSteps.length}`,
    );
  } else {
    if (!hasScheduledFailureCondition(failureAttributionStep)) {
      problems.push(
        "native probe failure attribution must run only when failure() && github.event_name == 'schedule'",
      );
    }
    if (!hasYamlValue(failureAttributionStep, "continue-on-error", "true")) {
      problems.push(
        "native probe failure attribution must set continue-on-error: true",
      );
    }
    if (
      diagnosticsCollectionStepIndex !== -1 &&
      failureAttributionStepIndex > diagnosticsCollectionStepIndex
    ) {
      problems.push(
        "native probe failure attribution must run before diagnostics collection",
      );
    }

    const attributionValue = stepEnvironmentValue(
      failureAttributionStep,
      "API_TYPECHECK_NATIVE_PROBE_FAILURE",
    );
    const phaseAttributionValue = stepEnvironmentValue(
      failureAttributionStep,
      "API_TYPECHECK_NATIVE_PROBE_PHASE",
    );
    const normalizedPhaseAttributionValue = phaseAttributionValue.replace(
      /\s+/g,
      " ",
    );
    if (
      !normalizedPhaseAttributionValue.includes(
        "steps.native-process-identity.outcome == 'failure' && steps.native-process-identity.outputs.phase",
      )
    ) {
      problems.push(
        "native probe failure attribution must map the stale-lock-takeover step output to API_TYPECHECK_NATIVE_PROBE_PHASE",
      );
    }
    if (!phaseAttributionValue.includes("'not-applicable'")) {
      problems.push(
        'native probe failure attribution must use the safe fallback phase "not-applicable"',
      );
    }
    for (const { step, label, command } of nativeProcessFailureAttributions) {
      const producerStep = stepBlocks.find(
        (candidate) => stepRunCommand(candidate) === command,
      );
      if (!producerStep || stepId(producerStep) !== step) {
        problems.push(
          `native probe failure attribution requires step id "${step}" on command ${command}`,
        );
      }
      if (
        !attributionValue.includes(
          `steps.${step}.outcome == 'failure' && '${label}'`,
        )
      ) {
        problems.push(
          `native probe failure attribution must map steps.${step}.outcome to the safe label "${label}"`,
        );
      }
    }
    if (!attributionValue.includes("'unknown'")) {
      problems.push(
        'native probe failure attribution must use the safe fallback label "unknown"',
      );
    }
    const quotedLabels = [
      ...attributionValue.matchAll(/&&\s*'([^']+)'|(?:^|\s)'([^']+)'\s*\}\}/g),
    ].map((match) => match[1] ?? match[2]);
    const recognizedLabels = new Set([
      ...nativeProcessFailureAttributions.map(({ label }) => label),
      "unknown",
    ]);
    if (
      quotedLabels.some(
        (label) =>
          !/^[a-z0-9-]+$/.test(label) || !recognizedLabels.has(label),
      )
    ) {
      problems.push(
        "native probe failure attribution may contain only recognized safe labels",
      );
    }
  }
  if (diagnosticsCollectionSteps.length === 0) {
    problems.push(
      "must retain a scheduled-failure diagnostics collection step using --collect-native-process-diagnostics",
    );
  } else if (diagnosticsCollectionSteps.length > 1) {
    problems.push(
      `must contain exactly one scheduled-failure diagnostics collection step using --collect-native-process-diagnostics; found ${diagnosticsCollectionSteps.length}`,
    );
  } else {
    if (!hasScheduledFailureCondition(diagnosticsCollectionStep)) {
      problems.push(
        "scheduled-failure diagnostics collection must run only when failure() && github.event_name == 'schedule'",
      );
    }
    if (!hasYamlValue(diagnosticsCollectionStep, "continue-on-error", "true")) {
      problems.push(
        "scheduled-failure diagnostics collection must set continue-on-error: true",
      );
    }
  }
  if (!recoveryProbeStep) {
    problems.push(
      'must retain a PID-reuse recovery probe step with id "native-process-identity-recovery"',
    );
  } else if (
    !stepEnvironmentValue(
      recoveryProbeStep,
      "API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE",
    ).includes("pid-reuse-recovery-batch.json")
  ) {
    problems.push(
      "PID-reuse recovery probe must record its diagnostic artifact path",
    );
  }

  const recoveryDiagnosticsValidationSteps = stepBlocks.filter(
    (step) =>
      stepRunCommand(step) ===
      nativeProcessRecoveryDiagnosticsValidationCommand,
  );
  if (recoveryDiagnosticsValidationSteps.length !== 1) {
    problems.push(
      `must contain exactly one scheduled PID-reuse recovery record validation step; found ${recoveryDiagnosticsValidationSteps.length}`,
    );
  } else {
    const recoveryDiagnosticsValidationStep =
      recoveryDiagnosticsValidationSteps[0];
    const recoveryDiagnosticsValidationStepIndex = stepBlocks.indexOf(
      recoveryDiagnosticsValidationStep,
    );
    const validationCondition =
      recoveryDiagnosticsValidationStep.match(/^\s*if:\s*(.*?)\s*$/m)?.[1] ??
      "";
    if (
      stepId(recoveryDiagnosticsValidationStep) !==
      "native-process-identity-recovery-record"
    ) {
      problems.push(
        'PID-reuse recovery record validation must use step id "native-process-identity-recovery-record"',
      );
    }
    if (
      !/github\.event_name\s*==\s*['"]schedule['"]/.test(validationCondition) ||
      !/steps\.native-process-identity-recovery\.outcome\s*==\s*['"]success['"]/.test(
        validationCondition,
      )
    ) {
      problems.push(
        "PID-reuse recovery record validation must run on scheduled runs after a successful recovery probe",
      );
    }
    if (
      !stepEnvironmentValue(
        recoveryDiagnosticsValidationStep,
        "API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE",
      ).includes("pid-reuse-recovery-batch.json")
    ) {
      problems.push(
        "PID-reuse recovery record validation must read pid-reuse-recovery-batch.json",
      );
    }
    if (
      !recoveryProbeStep ||
      recoveryDiagnosticsValidationStepIndex <=
        stepBlocks.indexOf(recoveryProbeStep)
    ) {
      problems.push(
        "PID-reuse recovery record validation must run after its recovery probe",
      );
    }
    if (
      (failureAttributionStepIndex !== -1 &&
        recoveryDiagnosticsValidationStepIndex >=
          failureAttributionStepIndex) ||
      (diagnosticsCollectionStepIndex !== -1 &&
        recoveryDiagnosticsValidationStepIndex >=
          diagnosticsCollectionStepIndex)
    ) {
      problems.push(
        "PID-reuse recovery record validation must run before failure attribution and diagnostics collection",
      );
    }
  }

  const recoveryUploadSteps = stepBlocks.filter(
    (step) => stepId(step) === "native-process-identity-recovery-upload",
  );
  if (recoveryUploadSteps.length !== 1) {
    problems.push("must retain exactly one successful weekly recovery record upload");
  } else {
    const upload = recoveryUploadSteps[0];
    const condition = upload.match(/^\s*if:\s*(.*?)\s*$/m)?.[1];
    if (condition !== "${{ success() && github.event_name == 'schedule' && steps.native-process-identity-recovery-record.outcome == 'success' }}") {
      problems.push("successful weekly recovery record upload must require scheduled success and successful record validation");
    }
    if (stepUsesAction(upload) !== "actions/upload-artifact@v4") {
      problems.push("successful weekly recovery record upload must use actions/upload-artifact@v4");
    }
    const validation = recoveryDiagnosticsValidationSteps[0];
    const uploadPath = upload.match(/^\s*path:\s*(.*?)\s*$/m)?.[1];
    const expectedPath = "${{ runner.temp }}/native-process-diagnostics/pid-reuse-recovery-batch.json";
    if (
      uploadPath !== expectedPath ||
      stepEnvironmentValue(validation ?? "", "API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE") !== expectedPath ||
      stepEnvironmentValue(recoveryProbeStep ?? "", "API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE") !== expectedPath
    ) {
      problems.push("successful weekly recovery record upload must include only the validated PID-reuse JSON");
    }
    if (
      !validation ||
      stepBlocks.indexOf(upload) <= stepBlocks.indexOf(validation) ||
      stepBlocks.indexOf(upload) <= stepBlocks.indexOf(interruptedPublicationProbeStep)
    ) {
      problems.push("successful weekly recovery record upload must run after validation and all native probes");
    }
    if (!hasYamlValue(upload, "if-no-files-found", "error")) {
      problems.push("successful weekly recovery record upload must fail when its JSON is missing");
    }
    if (!hasYamlValue(upload, "retention-days", "28")) {
      problems.push("successful weekly recovery record upload must retain records for 28 days");
    }
    const name = upload.match(/^\s*name:\s*(.*?)\s*$/m)?.[1];
    if (name !== "native-process-recovery-record-${{ matrix.os }}-node-${{ matrix.node }}") {
      problems.push("successful weekly recovery record artifact name must be distinct from failure bundles and unique by host and Node");
    }
  }

  const diagnosticsUploadStep = stepBlocks.find((step) =>
    step.includes("uses: actions/upload-artifact@v4") &&
    stepId(step) !== "native-process-identity-recovery-upload",
  );
  if (!diagnosticsUploadStep) {
    problems.push(
      "must retain an upload-artifact step for scheduled-failure diagnostics",
    );
  } else {
    if (!hasScheduledFailureCondition(diagnosticsUploadStep)) {
      problems.push(
        "scheduled-failure diagnostics upload must run only when failure() && github.event_name == 'schedule'",
      );
    }
    if (!hasYamlKey(diagnosticsUploadStep, "path")) {
      problems.push(
        "scheduled-failure diagnostics upload must specify an artifact path",
      );
    } else {
      const recoveryDiagnosticsPath = recoveryProbeStep
        ? stepEnvironmentValue(
            recoveryProbeStep,
            "API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE",
          )
        : "";
      const recoveryDiagnosticsDirectory = recoveryDiagnosticsPath.replace(
        /[\\/]+pid-reuse-recovery-batch\.json$/,
        "",
      );
      const artifactUploadPath =
        diagnosticsUploadStep.match(/^\s*path:\s*(.*?)\s*$/m)?.[1] ?? "";
      if (
        !recoveryDiagnosticsDirectory ||
        !artifactUploadPath.includes(recoveryDiagnosticsDirectory)
      ) {
        problems.push(
          "scheduled-failure diagnostics upload path must include the PID-reuse recovery record directory",
        );
      }
    }
    if (!hasMatrixValueInArtifactName(diagnosticsUploadStep, "os")) {
      problems.push(
        "scheduled-failure diagnostics artifact name must include matrix.os",
      );
    }
    if (!hasMatrixValueInArtifactName(diagnosticsUploadStep, "node")) {
      problems.push(
        "scheduled-failure diagnostics artifact name must include matrix.node",
      );
    }
    if (
      hasMatrixValueInArtifactName(diagnosticsUploadStep, "os") &&
      hasMatrixValueInArtifactName(diagnosticsUploadStep, "node")
    ) {
      const artifactNamesByValue = new Map();
      for (const { entry, name } of nativeProcessDiagnosticArtifactNames({
        workflow,
      })) {
        const entries = artifactNamesByValue.get(name) ?? [];
        entries.push(entry);
        artifactNamesByValue.set(name, entries);
      }
      const collidingArtifactNames = [...artifactNamesByValue].filter(
        ([, entries]) => entries.length > 1,
      );
      if (collidingArtifactNames.length > 0) {
        problems.push(
          `scheduled-failure diagnostics artifact names must be unique for required native process matrix entries: ${collidingArtifactNames
            .map(
              ([name, entries]) =>
                `"${name}" collides for ${entries
                  .map(nativeProcessMatrixEntryContext)
                  .join("; ")}`,
            )
            .join(", ")}`,
        );
      }
    }
    if (!hasYamlValue(diagnosticsUploadStep, "if-no-files-found", "ignore")) {
      problems.push(
        "scheduled-failure diagnostics upload must set if-no-files-found: ignore",
      );
    }
    if (!hasYamlKey(diagnosticsUploadStep, "retention-days")) {
      problems.push(
        "scheduled-failure diagnostics upload must set an explicit retention-days value",
      );
    } else if (
      !hasFinitePositiveIntegerYamlValue(
        diagnosticsUploadStep,
        "retention-days",
      )
    ) {
      problems.push(
        "scheduled-failure diagnostics upload retention-days must be a finite positive integer",
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "The native process workflow coverage contract has drifted.",
        `Workflow: .github/workflows/${nativeProcessWorkflowName}`,
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }

  return {
    workflow: nativeProcessWorkflowName,
    matrix: requiredNativeProcessMatrixEntries,
    probes: requiredNativeProcessProbeCommands,
  };
}

export function checkNativeProcessDiagnosticsCollectorContract({ collector }) {
  if (typeof collector !== "string") {
    throw new Error("Missing native process diagnostics collector source");
  }
  const problems = [];
  if (!collector.includes('"probe-attribution.json"')) {
    problems.push(
      'must write attribution metadata to "probe-attribution.json"',
    );
  }
  if (!collector.includes('"pid-reuse-recovery-batch.json"')) {
    problems.push(
      'must record PID-reuse recovery details in "pid-reuse-recovery-batch.json"',
    );
  }
  for (const requiredField of [
    "failureLabel: nativeProcessRecoveryFailureLabel",
    "affectedTransactions",
    "directory: transactionDirectory",
    "paths: [source]",
    "host:",
    "runtime:",
  ]) {
    if (!collector.includes(requiredField)) {
      problems.push(
        `must record PID-reuse recovery diagnostic field "${requiredField.replace(/:.*/, "")}"`,
      );
    }
  }
  if (
    !collector.includes(
      'nativeProcessRecoveryFailureLabel = "pid-reuse-recovery-batch"',
    )
  ) {
    problems.push(
      'must keep the PID-reuse recovery failure label "pid-reuse-recovery-batch" stable',
    );
  }
  if (
    !/failedStep:\s*process\.env\.API_TYPECHECK_NATIVE_PROBE_FAILURE\s*\?\?\s*"unknown"/.test(
      collector,
    )
  ) {
    problems.push(
      'must write API_TYPECHECK_NATIVE_PROBE_FAILURE to the "failedStep" metadata field with the safe "unknown" fallback',
    );
  }
  if (
    !/failedPhase:\s*process\.env\.API_TYPECHECK_NATIVE_PROBE_PHASE\s*\?\?\s*"unknown"/.test(
      collector,
    )
  ) {
    problems.push(
      'must write API_TYPECHECK_NATIVE_PROBE_PHASE to the "failedPhase" metadata field with the safe "unknown" fallback',
    );
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "The native process diagnostics collector contract has drifted.",
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }
  return {
    fileName: "probe-attribution.json",
    field: "failedStep",
    phaseField: "failedPhase",
  };
}

export function checkNativeProcessProbeContract({ probe }) {
  if (typeof probe !== "string") {
    throw new Error("Missing native process probe source");
  }
  const problems = [];
  const phaseDeclaration = probe.match(
    /const nativeProcessProbePhases = new Set\(\[([\s\S]*?)\]\);/,
  );
  const declaredPhases = phaseDeclaration
    ? [...phaseDeclaration[1].matchAll(/"([^"]+)"/g)].map(([, phase]) => phase)
    : [];
  if (!phaseDeclaration) {
    problems.push("must define the native process probe phase allow-list");
  } else {
    const unsafePhases = declaredPhases.filter(
      (phase) => !/^[a-z0-9-]+$/.test(phase),
    );
    if (unsafePhases.length > 0) {
      problems.push(
        `native process probe phases must be safe labels; found ${unsafePhases.join(", ")}`,
      );
    }
    if (
      declaredPhases.length !== requiredNativeProcessProbePhases.length ||
      declaredPhases.some(
        (phase, index) => phase !== requiredNativeProcessProbePhases[index],
      )
    ) {
      problems.push(
        `must keep the native process probe phases fixed: ${requiredNativeProcessProbePhases.join(", ")}`,
      );
    }
  }

  const staleLockProbeStart = probe.indexOf("if (testNativeProcessIdentity) {");
  const staleLockProbeEnd = probe.search(
    /if \(testNativeTransitionLockOwnerExitProbe(?: \|\| runNativeTransitionInterruptionFixture)?\) \{/,
  );
  const staleLockProbe =
    staleLockProbeStart === -1 || staleLockProbeEnd === -1
      ? ""
      : probe.slice(staleLockProbeStart, staleLockProbeEnd);
  if (!staleLockProbe) {
    problems.push("must retain the stale-lock native process identity probe");
  } else {
    for (const phase of requiredNativeProcessProbePhases) {
      if (
        !new RegExp(
          `(?:let\\s+)?phase = "${phase}";\\s*await exposeNativeProcessProbePhase\\(phase\\);`,
        ).test(staleLockProbe)
      ) {
        problems.push(
          `stale-lock native process identity probe must emit the fixed phase "${phase}"`,
        );
      }
    }
  }

  const outputFunction = probe.match(
    /async function exposeNativeProcessProbePhase\(phase\) \{([\s\S]*?)\n\}/,
  )?.[1];
  if (
    !outputFunction ||
    !outputFunction.includes("!nativeProcessProbePhases.has(phase)") ||
    !outputFunction.includes("process.env.GITHUB_OUTPUT") ||
    !outputFunction.includes("`phase=${phase}\\n`")
  ) {
    problems.push(
      "native process probe phases must be emitted as the phase output",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "The native process probe contract has drifted.",
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }
  return { phases: requiredNativeProcessProbePhases };
}

export function checkNativeProcessWorkflowContract({ workflows }) {
  const nativeProcessWorkflow = workflows?.[nativeProcessWorkflowName];
  const problems = [];

  if (typeof nativeProcessWorkflow !== "string") {
    throw new Error(
      `Missing .github/workflows/${nativeProcessWorkflowName}; the native process workflow is required`,
    );
  }

  const parsedTriggerSections = new Map();
  for (const [workflowName, workflow] of Object.entries(workflows ?? {})) {
    if (typeof workflow !== "string") {
      continue;
    }
    try {
      parsedTriggerSections.set(workflowName, workflowTriggerSections(workflow));
    } catch (error) {
      problems.push(
        `.github/workflows/${workflowName} has invalid trigger syntax in ${workflowTriggerRepresentation(workflow)}: ${error instanceof Error ? error.message.replace(/^Unsupported GitHub Actions trigger syntax:\s*/, "") : "unable to parse the trigger declaration"}`,
      );
      parsedTriggerSections.set(workflowName, []);
    }
  }

  const nativeSections =
    parsedTriggerSections.get(nativeProcessWorkflowName) ?? [];
  const countTrigger = (name) =>
    nativeSections.filter((section) => section.name === name).length;

  if (countTrigger("pull_request") !== 1) {
    problems.push("must declare exactly one pull_request trigger");
  }

  const pushSections = nativeSections.filter(
    (section) => section.name === "push",
  );
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
      ([workflowName, workflow]) =>
        typeof workflow === "string" &&
        scheduleEntryCount(parsedTriggerSections.get(workflowName) ?? []) > 0,
    )
    .map(([workflowName]) => workflowName)
    .sort();
  problems.push(
    ...scheduledArtifactUploadProblems({ workflows, parsedTriggerSections }),
  );
  // The daily merge-check audit is independent of the native-process audit.
  // Keep the exception explicit so unrelated workflows cannot gain schedules.
  const permittedScheduledWorkflows = [
    nativeProcessWorkflowName,
    "required-merge-checks.yml",
  ];
  if (scheduledWorkflowNames.some(
    (name) => !permittedScheduledWorkflows.includes(name),
  )) {
    problems.push(
      `scheduled workflows may only be ${permittedScheduledWorkflows.map((name) => `.github/workflows/${name}`).join(", ")}; found ${scheduledWorkflowNames.map((name) => `.github/workflows/${name}`).join(", ")}`,
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

export function checkNodeSupportMatrix({
  packageJson,
  workflows,
  workflow,
  nodeVersionFiles = {},
}) {
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

    let matrix;
    try {
      matrix = workflowNodeMajors(workflowContents, { nodeVersionFiles });
    } catch (error) {
      drift.push(
        [
          `Workflow: .github/workflows/${workflowName}`,
          `Supported Node versions from package.json: ${JSON.stringify(supported)}`,
          "Declared Node versions: []",
          `Validation: ${error instanceof Error ? error.message : String(error)}`,
        ].join("\n"),
      );
      continue;
    }
    const policy = workflowNodeVersionPolicies[workflowName] ?? {
      match: "exact",
    };
    checkedWorkflows.push({
      workflow: workflowName,
      matrix,
      policy: policy.match,
    });

    if (workflowName === "welcome-recovery-postgres.yml") {
      const setupSteps = workflowStepBlocks(workflowContents).filter((step) =>
        /^actions\/setup-node@/.test(stepUsesAction(step) ?? ""),
      );
      if (setupSteps.length === 0 || setupSteps.some((step) => !hasMatrixNodeVersion(step))) {
        drift.push(
          [
            `Workflow: .github/workflows/${workflowName}`,
            "Validation: actions/setup-node must use node-version: ${{ matrix.node }} so every declared Node major runs.",
          ].join("\n"),
        );
      }
    }

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

export async function loadWorkflowFiles({ repositoryRoot = workspaceRoot } = {}) {
  const realRoot = await realpath(path.resolve(repositoryRoot));
  const workflowDirectory = path.join(realRoot, ".github", "workflows");
  const workflowNames = (await readdir(workflowDirectory))
    .filter((name) => /\.(?:yaml|yml)$/i.test(name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      workflowNames.map(async (workflowName) => {
        const workflowPath = `.github/workflows/${workflowName}`;
        let resolvedTarget;
        try {
          resolvedTarget = await realpath(path.join(workflowDirectory, workflowName));
        } catch {
          throw new Error(`Workflow: ${workflowPath}\nWorkflow file could not be resolved`);
        }
        const relativeTarget = path.relative(realRoot, resolvedTarget);
        if (
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeTarget)
        ) {
          throw new Error(`Workflow: ${workflowPath}\nWorkflow file resolves outside the repository`);
        }
        try {
          return [workflowName, await readFile(resolvedTarget, "utf8")];
        } catch {
          throw new Error(`Workflow: ${workflowPath}\nWorkflow file could not be read`);
        }
      }),
    ),
  );
}

const isMainModule =
  process.argv[1] &&
  (await realpath(process.argv[1])) ===
    (await realpath(fileURLToPath(import.meta.url)));

if (isMainModule) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const apiTypecheckHarnessSource = await readFile(
    path.join(workspaceRoot, "scripts", "check-api-typecheck-rebuilds-db.mjs"),
    "utf8",
  );
  const workflows = await loadWorkflowFiles();
  const { nodeVersionFiles, nodeVersionFileTargets, nodeVersionFileDependencies } =
    await loadNodeVersionFileInputs(workflows);
  checkNodeVersionFileTriggerCoverage({ workflows, nodeVersionFileTargets, nodeVersionFileDependencies });
  checkNodeCompatibilityGuardCoverage({ workflows });
  checkLocalReusableNodeGuardCoverage({ workflows });
  checkStandardRecoveryCommandContract({ packageJson });
  checkRecoveryRegressionCommandCoverage({
    packageJson,
    apiTypecheckHarnessSource,
  });
  checkNativeProcessWorkflowContract({ workflows });
  checkNativeProcessWorkflowStepOrder({
    workflow: workflows[nativeProcessWorkflowName],
  });
  checkNativeProcessWorkflowCoverage({
    workflow: workflows[nativeProcessWorkflowName],
  });
  checkNativeProcessProbeContract({
    probe: apiTypecheckHarnessSource,
  });
  checkNativeProcessDiagnosticsCollectorContract({
    collector: apiTypecheckHarnessSource,
  });
  const { supported, workflows: checkedWorkflows } = checkNodeSupportMatrix({
    packageJson,
    workflows,
    nodeVersionFiles,
  });

  console.log(
    `Node support matches ${checkedWorkflows.length} workflow(s): ${supported.join(", ")}`,
  );
}
