import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCleanupAggregateError,
  createCleanupFailure,
  describeCleanupFailures,
  describeError,
} from "./frontend-typecheck-refresh-cleanup.mjs";
import {
  describeNoFrontendDiscovery,
  matchesWorkspacePackageScopes,
  parseWorkspacePackagePatterns,
} from "./workspace-package-patterns.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceConfigPath = path.join(workspaceRoot, "pnpm-workspace.yaml");
const generatedSource = path.join(
  workspaceRoot,
  "lib/api-client-react/src/generated/api.schemas.ts",
);
const generatedReactClient = path.join(
  workspaceRoot,
  "lib/api-client-react/src/generated/api.ts",
);
const apiClientPackageName = "@workspace/api-client-react";
const nonFrontendWorkspacePackageNames = new Set([
  "@workspace/api-client-react",
  "@workspace/api-server",
  "@workspace/api-spec",
  "@workspace/api-zod",
  "@workspace/db",
  "@workspace/integrations-gemini-ai",
  "@workspace/integrations-openai-ai-server",
  "@workspace/scripts",
]);
const originalSource = await readFile(generatedSource, "utf8");
const originalReactClient = await readFile(generatedReactClient, "utf8");

async function findPackageDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const packageDirectories = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name === "package.json") {
      packageDirectories.push(directory);
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".local" ||
      entry.name === "dist"
    ) {
      continue;
    }

    packageDirectories.push(
      ...(await findPackageDirectories(path.join(directory, entry.name))),
    );
  }

  return packageDirectories;
}

async function discoverWorkspacePackageDirectories() {
  const workspaceConfig = await readFile(workspaceConfigPath, "utf8");
  const packagePatterns = parseWorkspacePackagePatterns(
    workspaceConfig,
    workspaceRelativePath(workspaceConfigPath),
  );
  const packageDirectories = await findPackageDirectories(workspaceRoot);

  const matchingPackageDirectories = packageDirectories
    .filter((packageDirectory) => {
      const relativePath = workspaceRelativePath(packageDirectory);
      return matchesWorkspacePackageScopes(relativePath, packagePatterns);
    })
    .sort();

  return { packagePatterns, packageDirectories: matchingPackageDirectories };
}

async function discoverFrontends() {
  // Every workspace package is considered, not only packages under artifacts/.
  // Known libraries and services stay explicitly excluded even if they later
  // add a dependency on the browser API client for tooling.
  const {
    packageDirectories,
    packagePatterns,
  } = await discoverWorkspacePackageDirectories();
  const frontends = [];

  for (const packageDirectory of packageDirectories) {
    const packagePath = path.join(packageDirectory, "package.json");
    let packageJson;

    try {
      packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw new Error(
        `Failed to read frontend package manifest ${workspaceRelativePath(packagePath)}: ${describeError(error)}`,
      );
    }

    if (nonFrontendWorkspacePackageNames.has(packageJson.name)) {
      continue;
    }

    const dependencySections = [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.optionalDependencies,
      packageJson.peerDependencies,
    ];
    const consumesApiClient = dependencySections.some(
      (dependencies) =>
        dependencies &&
        Object.prototype.hasOwnProperty.call(
          dependencies,
          apiClientPackageName,
        ),
    );

    if (!consumesApiClient) {
      continue;
    }

    if (typeof packageJson.scripts?.typecheck !== "string") {
      throw new Error(
        `Frontend ${packageJson.name ?? artifactEntry.name} consumes ${apiClientPackageName} but does not define a typecheck script.`,
      );
    }

    if (typeof packageJson.name !== "string") {
      throw new Error(
        `Frontend workspace package ${workspaceRelativePath(packagePath)} must define a package name for targeted typechecking.`,
      );
    }

    frontends.push({
      fixture: path.join(
        packageDirectory,
        "src/api-client-refresh-regression.ts",
      ),
      name: packageJson.name,
    });
  }

  frontends.sort((left, right) => left.name.localeCompare(right.name));

  if (frontends.length === 0) {
    throw new Error(
      describeNoFrontendDiscovery(
        workspaceRelativePath(workspaceConfigPath),
        packagePatterns,
        apiClientPackageName,
      ),
    );
  }

  return frontends;
}

function workspaceRelativePath(filePath) {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

function emitGithubErrorAnnotation(filePath, message) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return;
  }

  const escapeCommandValue = (value) =>
    value
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");

  process.stderr.write(
    `::error file=${escapeCommandValue(filePath)}::${escapeCommandValue(message)}\n`,
  );
}

function runFrontendTypecheck(frontend, assertionLabel, generatedPath) {
  const result = spawnSync(
    "pnpm",
    ["--filter", frontend.name, "run", "typecheck"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    if (generatedPath) {
      const diagnostic = result.stderr || result.stdout;
      const failureMessage = `Frontend ${frontend.name} typecheck failed while verifying the ${assertionLabel} generated API refresh assertion.`;
      emitGithubErrorAnnotation(
        workspaceRelativePath(generatedPath),
        diagnostic ? `${failureMessage}\n${diagnostic}` : failureMessage,
      );
    }
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      `Frontend ${frontend.name} typecheck failed while verifying the ${assertionLabel} generated API refresh assertion (exit status ${result.status}).`,
    );
  }
}

const markerName = "FrontendTypecheckRefreshRegression";
const hookName = "useFrontendTypecheckRefreshRegression";
const mutationClientName = "frontendTypecheckRefreshRegressionMutationClient";

function generatedSchemaWithMarker(value) {
  return `${originalSource}\nexport type ${markerName} = "${value}";\n`;
}

function generatedReactClientWithDeclarations(declarations = "") {
  return `${originalReactClient}${declarations}`;
}

async function runRefreshAssertion({
  label,
  beforeSchema,
  beforeReactClient,
  afterSchema,
  afterReactClient,
  fixture,
  generatedPath,
  frontends,
}) {
  await writeFile(generatedSource, beforeSchema);
  await writeFile(generatedReactClient, beforeReactClient);
  await Promise.all(
    frontends.map((frontend) => rm(frontend.fixture, { force: true })),
  );
  for (const frontend of frontends) {
    runFrontendTypecheck(frontend, `${label} before-refresh`, generatedPath);
  }

  await writeFile(generatedSource, afterSchema);
  await writeFile(generatedReactClient, afterReactClient);
  for (const frontend of frontends) {
    await writeFile(frontend.fixture, fixture);
    runFrontendTypecheck(frontend, label, generatedPath);
    await rm(frontend.fixture, { force: true });
  }
}

async function restoreRefreshCheckFiles(frontends) {
  const operations = [
    {
      label: "Generated schema restoration",
      operation: writeFile(generatedSource, originalSource),
    },
    {
      label: "Generated client restoration",
      operation: writeFile(generatedReactClient, originalReactClient),
    },
    ...frontends.map((frontend) => ({
      label: `Fixture removal for ${frontend.name}`,
      operation: rm(frontend.fixture, { force: true }),
    })),
  ];
  const results = await Promise.allSettled(
    operations.map(({ operation }) => operation),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [createCleanupFailure(operations[index].label, result.reason)]
      : [],
  );

  if (failures.length > 0) {
    throw createCleanupAggregateError(
      "Failed to restore one or more frontend refresh-check files.",
      failures,
    );
  }
}

function runCleanupTypechecks(frontends) {
  const failures = [];

  for (const frontend of frontends) {
    try {
      runFrontendTypecheck(frontend, "cleanup");
    } catch (error) {
      failures.push(
        createCleanupFailure(`Cleanup typecheck for ${frontend.name}`, error),
      );
    }
  }

  if (failures.length > 0) {
    throw createCleanupAggregateError(
      "One or more frontend cleanup typechecks failed.",
      failures,
    );
  }
}

const frontends = await discoverFrontends();

console.log(
  `Checking generated API refreshes for ${frontends.length} frontend(s): ${frontends
    .map((frontend) => frontend.name)
    .join(", ")}.`,
);

let validationFailure;

try {
  await runRefreshAssertion({
    label: "schema",
    beforeSchema: generatedSchemaWithMarker("before"),
    beforeReactClient: originalReactClient,
    afterSchema: generatedSchemaWithMarker("after"),
    afterReactClient: originalReactClient,
    fixture: `import type { ${markerName} } from "@workspace/api-client-react";

const refreshedType: ${markerName} = "after";
void refreshedType;
`,
    generatedPath: generatedSource,
    frontends,
  });

  await runRefreshAssertion({
    label: "React hook",
    beforeSchema: originalSource,
    beforeReactClient: generatedReactClientWithDeclarations(`
export const ${hookName} = (): "before" => "before";
`),
    afterSchema: originalSource,
    afterReactClient: generatedReactClientWithDeclarations(`
export const ${hookName} = (): "after" => "after";
`),
    fixture: `import { ${hookName} } from "@workspace/api-client-react";

const refreshedHookResult: ReturnType<typeof ${hookName}> = "after";
void refreshedHookResult;
`,
    generatedPath: generatedReactClient,
    frontends,
  });

  await runRefreshAssertion({
    label: "client export",
    beforeSchema: originalSource,
    beforeReactClient: generatedReactClientWithDeclarations(`
export const ${mutationClientName} = async (): Promise<"before"> => "before";
`),
    afterSchema: originalSource,
    afterReactClient: generatedReactClientWithDeclarations(`
export const ${mutationClientName} = async (): Promise<"after"> => "after";
`),
    fixture: `import { ${mutationClientName} } from "@workspace/api-client-react";

const refreshedMutationResult: Awaited<
  ReturnType<typeof ${mutationClientName}>
> = "after";
void refreshedMutationResult;
`,
    generatedPath: generatedReactClient,
    frontends,
  });

  console.log(
    `All ${frontends.length} frontend(s) refreshed generated API schema, React hook, and client export assertions successfully.`,
  );
} catch (error) {
  validationFailure = error;
} finally {
  const cleanupFailures = [];

  try {
    await restoreRefreshCheckFiles(frontends);
  } catch (error) {
    cleanupFailures.push(error);
  }

  try {
    runCleanupTypechecks(frontends);
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (cleanupFailures.length > 0) {
    const cleanupFailure = createCleanupAggregateError(
      "Frontend refresh-check cleanup failed.",
      cleanupFailures,
    );

    if (validationFailure) {
      process.stderr.write(
        "Frontend refresh-check cleanup failed after the original validation failure:\n",
      );
      process.stderr.write(`${describeCleanupFailures(cleanupFailure)}\n`);
    } else {
      throw cleanupFailure;
    }
  }
}

if (validationFailure) {
  throw validationFailure;
}
