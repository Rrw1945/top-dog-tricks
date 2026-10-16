import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import {
  describeNoFrontendDiscovery,
  matchesWorkspacePackagePattern,
  matchesWorkspacePackageScopes,
  parseWorkspacePackagePatterns,
} from "./workspace-package-patterns.mjs";

const test = (name, callback) =>
  nodeTest(name, { concurrency: false }, callback);

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const checkScript = path.join(
  workspaceRoot,
  "scripts/check-frontend-typecheck-refreshes-api-client.mjs",
);
const generatedSchemaPath = path.join(
  workspaceRoot,
  "lib/api-client-react/src/generated/api.schemas.ts",
);
const generatedClientPath = path.join(
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

function getRootTypecheckSelectors(typecheckCommand) {
  return [
    ...typecheckCommand.matchAll(/--filter\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gu),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
}

function listWorkspacePackages(selectors = []) {
  const args = [
    "-r",
    ...selectors.flatMap((selector) => ["--filter", selector]),
    "list",
    "--depth",
    "-1",
    "--json",
  ];
  const result = spawnSync("pnpm", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  return JSON.parse(result.stdout).filter(
    (workspacePackage) => path.resolve(workspacePackage.path) !== workspaceRoot,
  );
}

function consumesApiClient(manifest) {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].some(
    (dependencies) =>
      dependencies &&
      Object.prototype.hasOwnProperty.call(dependencies, apiClientPackageName),
  );
}

function getRefreshFrontendNames(stdout) {
  const match = stdout.match(
    /^Checking generated API refreshes for \d+ frontend\(s\): (.+)\.$/mu,
  );
  assert.ok(match, "Expected the refresh check to list its frontend packages.");

  return match[1].split(", ");
}

test("root typecheck covers frontend scopes from workspace configuration", async () => {
  await withTemporaryFrontend(
    async ({ artifactPath, packageName }) => {
      const rootPackage = JSON.parse(
        await readFile(path.join(workspaceRoot, "package.json"), "utf8"),
      );
      const selectors = getRootTypecheckSelectors(
        rootPackage.scripts.typecheck,
      );
      const workspacePackages = listWorkspacePackages();
      const selectedPackages = listWorkspacePackages(selectors);
      const selectedPaths = new Set(
        selectedPackages.map((workspacePackage) =>
          path.resolve(workspacePackage.path),
        ),
      );
      const frontendPackages = await Promise.all(
        workspacePackages.map(async (workspacePackage) => ({
          ...workspacePackage,
          manifest: JSON.parse(
            await readFile(
              path.join(workspacePackage.path, "package.json"),
              "utf8",
            ),
          ),
        })),
      );
      const apiClientFrontends = frontendPackages.filter(
        ({ manifest }) =>
          !nonFrontendWorkspacePackageNames.has(manifest.name) &&
          typeof manifest.scripts?.typecheck === "string" &&
          consumesApiClient(manifest),
      );

      assert.ok(
        apiClientFrontends.some(
          ({ manifest }) => manifest.name === packageName,
        ),
        `Expected the temporary frontend in ${path.relative(workspaceRoot, artifactPath)} to be discovered.`,
      );

      for (const frontend of apiClientFrontends) {
        assert.ok(
          selectedPaths.has(path.resolve(frontend.path)),
          `Root typecheck does not select frontend ${frontend.manifest.name} in ${frontend.path}.`,
        );
      }

      for (const workspacePackage of workspacePackages.filter(
        ({ path: packagePath }) =>
          path.relative(workspaceRoot, packagePath).startsWith("lib/"),
      )) {
        assert.equal(
          selectedPaths.has(path.resolve(workspacePackage.path)),
          false,
          `Root recursive typecheck must not select library package ${workspacePackage.path}.`,
        );
      }
    },
    "apps",
    "@workspace/typecheck-scope-regression",
  );
});

test("discovers nested workspace package patterns and applies explicit exclusions", () => {
  const patterns = parseWorkspacePackagePatterns(
    `packages:\n  - apps/**/packages/*\n  - '!apps/**/packages/private-*'\n`,
  );

  assert.deepEqual(patterns, [
    "apps/**/packages/*",
    "!apps/**/packages/private-*",
  ]);
  assert.equal(
    matchesWorkspacePackageScopes("apps/dogs/packages/rescue-web", patterns),
    true,
  );
  assert.equal(
    matchesWorkspacePackageScopes("apps/dogs/packages/private-tools", patterns),
    false,
  );
  assert.equal(
    matchesWorkspacePackageScopes("apps/dogs/tools/rescue-web", patterns),
    false,
  );
});

test("overlapping positive workspace scopes retain their union without duplicate packages", () => {
  const patterns = parseWorkspacePackagePatterns(
    `packages:\n  - apps/**/packages/*\n  - apps/dogs/packages/*\n  - sites/*\n`,
  );
  const candidates = [
    "apps/dogs/packages/rescue-web",
    "apps/cats/regional/packages/adoption-web",
    "sites/community",
    "apps/dogs/tools/rescue-web",
    "apps/dogs/packages/rescue-web/nested",
    "lib/api-client-react",
  ];

  assert.equal(
    patterns.filter((pattern) =>
      matchesWorkspacePackagePattern(candidates[0], pattern),
    ).length,
    2,
    "The regression package must match both broad and narrow scopes.",
  );
  for (const scopes of [patterns, [...patterns].reverse()]) {
    assert.deepEqual(
      candidates.filter((candidate) =>
        matchesWorkspacePackageScopes(candidate, scopes),
      ),
      [
        "apps/dogs/packages/rescue-web",
        "apps/cats/regional/packages/adoption-web",
        "sites/community",
      ],
    );
  }
});

test("nested exclusions override broad and narrow positive scopes in any order", () => {
  const positives = ["apps/**/packages/*", "apps/dogs/packages/*"];
  const exclusions = [
    "!apps/**/packages/private-*",
    "!apps/cats/**/packages/*",
    "!apps/dogs/packages/internal-*",
  ];
  const candidates = [
    ["apps/dogs/packages/rescue-web", true],
    ["apps/birds/regional/packages/adoption-web", true],
    ["apps/dogs/packages/private-tools", false],
    ["apps/birds/regional/packages/private-tools", false],
    ["apps/cats/packages/adoption-web", false],
    ["apps/cats/regional/packages/adoption-web", false],
    ["apps/dogs/packages/internal-tools", false],
    ["apps/birds/packages/internal-tools", true],
    ["apps/dogs/tools/rescue-web", false],
    ["sites/community", false],
  ];
  const patternOrders = [
    [...positives, ...exclusions],
    [...exclusions, ...positives],
    [positives[0], ...exclusions, positives[1]],
    [positives[1], ...exclusions, positives[0]],
  ];

  for (const order of patternOrders) {
    const patterns = parseWorkspacePackagePatterns(
      `packages:\n${order.map((pattern) => `  - '${pattern}'`).join("\n")}\n`,
    );
    for (const [candidate, expected] of candidates) {
      assert.equal(
        matchesWorkspacePackageScopes(candidate, patterns),
        expected,
        `${candidate} with scopes ${patterns.join(", ")}`,
      );
    }
  }
});

test("frontend discovery shares recursive, wildcard, and root-relative glob matching", () => {
  const pattern = "./apps/**/packages/site?";

  assert.equal(
    matchesWorkspacePackagePattern("apps/dogs/packages/site1", pattern),
    true,
  );
  assert.equal(
    matchesWorkspacePackagePattern("apps/dogs/packages/deep/site1", pattern),
    false,
  );
  assert.equal(
    matchesWorkspacePackagePattern("apps/dogs/packages/site12", pattern),
    false,
  );
});

test("parses inline workspace package lists including negated patterns", () => {
  const patterns = parseWorkspacePackagePatterns(
    `packages: ['apps/*', "artifacts/*", '!apps/private-*'] # inline scopes\n`,
  );

  assert.deepEqual(patterns, ["apps/*", "artifacts/*", "!apps/private-*"]);
  assert.equal(
    matchesWorkspacePackageScopes("apps/storefront", patterns),
    true,
  );
  assert.equal(
    matchesWorkspacePackageScopes("apps/private-tools", patterns),
    false,
  );
  assert.equal(
    matchesWorkspacePackageScopes("lib/api-client-react", patterns),
    false,
  );
});

test("discovery diagnostics identify the workspace config and package scopes", () => {
  const patterns = ["apps/**/packages/*", "!apps/**/packages/private-*"];
  const message = describeNoFrontendDiscovery(
    "pnpm-workspace.yaml",
    patterns,
    "@workspace/api-client-react",
  );

  assert.match(message, /pnpm-workspace\.yaml/);
  assert.match(message, /apps\/\*\*\/packages\/\*/);
  assert.match(message, /!apps\/\*\*\/packages\/private-\*/);
  assert.match(message, /@workspace\/api-client-react/);
});

test("rejects glob operators the local matcher cannot represent with the exact scope", () => {
  assert.throws(
    () =>
      parseWorkspacePackagePatterns(
        "packages:\n  - apps/{web,admin}\n",
        "pnpm-workspace.yaml",
      ),
    /pnpm-workspace\.yaml package scope "apps\/\{web,admin\}" uses glob syntax unsupported by frontend discovery/,
  );
});

const existingFrontendNames = [
  "@workspace/ghost-town-rescue",
  "@workspace/top-dog-tricks",
];

const fakePnpmSource = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const frontendName =
  process.argv[process.argv.indexOf("--filter") + 1] ?? "unknown frontend";
const generatedSchema = readFileSync(
  path.join(workspaceRoot, "lib/api-client-react/src/generated/api.schemas.ts"),
  "utf8",
);
const generatedClient = readFileSync(
  path.join(workspaceRoot, "lib/api-client-react/src/generated/api.ts"),
  "utf8",
);
function findPackageDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "package.json") {
      const packageJson = JSON.parse(
        readFileSync(path.join(directory, entry.name), "utf8"),
      );
      if (packageJson.name === frontendName) {
        return directory;
      }
      continue;
    }

    if (
      !entry.isDirectory() ||
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".local" ||
      entry.name === "dist"
    ) {
      continue;
    }

    const packageDirectory = findPackageDirectory(
      path.join(directory, entry.name),
    );
    if (packageDirectory) {
      return packageDirectory;
    }
  }

  return null;
}
const packageDirectory = findPackageDirectory(workspaceRoot);
const fixturePath = path.join(
  packageDirectory,
  "src/api-client-refresh-regression.ts",
);
const fixture = existsSync(fixturePath)
  ? readFileSync(fixturePath, "utf8")
  : null;
const snapshot = {
  frontendName,
  fixture,
  schemaBefore: generatedSchema.includes(
    'export type FrontendTypecheckRefreshRegression = "before";',
  ),
  schemaAfter: generatedSchema.includes(
    'export type FrontendTypecheckRefreshRegression = "after";',
  ),
  hookBefore: generatedClient.includes(
    'useFrontendTypecheckRefreshRegression = (): "before"',
  ),
  hookAfter: generatedClient.includes(
    'useFrontendTypecheckRefreshRegression = (): "after"',
  ),
  clientExportBefore: generatedClient.includes(
    'frontendTypecheckRefreshRegressionMutationClient = async (): Promise<"before">',
  ),
  clientExportAfter: generatedClient.includes(
    'frontendTypecheckRefreshRegressionMutationClient = async (): Promise<"after">',
  ),
};

if (process.env.REFRESH_CHECK_LOG) {
  appendFileSync(
    process.env.REFRESH_CHECK_LOG,
    JSON.stringify(snapshot) + "\n",
  );
}

const failureTarget = process.env.REFRESH_CHECK_FAILURE_TARGET;
const failureFrontend =
  process.env.REFRESH_CHECK_FAILURE_FRONTEND ?? "@workspace/top-dog-tricks";
const failurePhase = process.env.REFRESH_CHECK_FAILURE_PHASE ?? "before";
const isBeforeRefresh = fixture === null;
const matchesBeforeRefresh =
  isBeforeRefresh &&
  ((failureTarget === "schema" &&
    snapshot.schemaBefore) ||
    (failureTarget === "React hook" &&
      snapshot.hookBefore) ||
    (failureTarget === "client export" &&
      snapshot.clientExportBefore));
const matchesAfterRefresh =
  !isBeforeRefresh &&
  ((failureTarget === "schema" && snapshot.schemaAfter) ||
    (failureTarget === "React hook" && snapshot.hookAfter) ||
    (failureTarget === "client export" && snapshot.clientExportAfter));
const failureMatches =
  frontendName === failureFrontend &&
  ((failurePhase === "before" && matchesBeforeRefresh) ||
    (failurePhase === "after" && matchesAfterRefresh));

if (failureMatches) {
  process.stdout.write("compiler stdout for " + failureTarget + "\n");
  process.stderr.write(
    process.env.REFRESH_CHECK_FAILURE_DIAGNOSTIC ||
      "compiler stderr for " + failureTarget + "\n",
  );
  process.exit(1);
}

if (fixture?.includes("FrontendTypecheckRefreshRegression")) {
  if (fixture.includes("const refreshedType") && !snapshot.schemaAfter) {
    process.stderr.write("schema fixture was not refreshed\n");
    process.exit(1);
  }
  if (fixture.includes("const refreshedHookResult") && !snapshot.hookAfter) {
    process.stderr.write("React hook fixture was not refreshed\n");
    process.exit(1);
  }
  if (
    fixture.includes("const refreshedMutationResult") &&
    !snapshot.clientExportAfter
  ) {
    process.stderr.write("client export fixture was not refreshed\n");
    process.exit(1);
  }
}
`;

async function runRefreshCheck({
  githubActions = "false",
  failureTarget,
  failureFrontend,
  failurePhase,
  failureDiagnostic,
} = {}) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "frontend-refresh-check-"),
  );
  const fakeBin = path.join(temporaryDirectory, "bin");
  const fakePnpm = path.join(fakeBin, "pnpm");
  const logPath = path.join(temporaryDirectory, "invocations.jsonl");

  try {
    await mkdir(fakeBin);
    await writeFile(fakePnpm, fakePnpmSource, "utf8");
    await chmod(fakePnpm, 0o755);

    const result = spawnSync(process.execPath, [checkScript], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: githubActions,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        REFRESH_CHECK_FAILURE_TARGET: failureTarget ?? "",
        REFRESH_CHECK_FAILURE_FRONTEND:
          failureFrontend ?? "@workspace/top-dog-tricks",
        REFRESH_CHECK_FAILURE_PHASE: failurePhase ?? "before",
        REFRESH_CHECK_FAILURE_DIAGNOSTIC: failureDiagnostic ?? "",
        REFRESH_CHECK_LOG: logPath,
      },
    });

    const log = await readFile(logPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") {
        return "";
      }
      throw error;
    });

    return {
      result,
      invocations: log
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function withTemporaryFrontend(
  callback,
  parentDirectory = "artifacts",
  packageNameOverride,
  dependencySection = "devDependencies",
) {
  const parentPath = path.join(workspaceRoot, parentDirectory);
  await mkdir(parentPath, { recursive: true });
  const artifactPath = await mkdtemp(
    path.join(parentPath, "refresh-isolation-"),
  );
  const artifactName = path.basename(artifactPath);
  const packageName = packageNameOverride ?? `@workspace/${artifactName}`;
  const fixturePath = path.join(
    artifactPath,
    "src/api-client-refresh-regression.ts",
  );

  try {
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(
      path.join(artifactPath, "package.json"),
      JSON.stringify(
        {
          name: packageName,
          version: "0.0.0",
          private: true,
          type: "module",
          scripts: {
            typecheck: "node -e 'process.exit(0)'",
          },
          [dependencySection]: {
            "@workspace/api-client-react": "workspace:*",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    return await callback({ artifactPath, fixturePath, packageName });
  } finally {
    await rm(artifactPath, { recursive: true, force: true });
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function frontendNamesFromInvocations(invocations) {
  return [...new Set(invocations.map((invocation) => invocation.frontendName))];
}

function assertFrontendRefreshCycle(invocations, frontendName) {
  const frontendInvocations = invocations.filter(
    (invocation) => invocation.frontendName === frontendName,
  );
  const assertions = [
    ["schemaBefore", "schemaAfter", "const refreshedType"],
    ["hookBefore", "hookAfter", "const refreshedHookResult"],
    [
      "clientExportBefore",
      "clientExportAfter",
      "const refreshedMutationResult",
    ],
  ];

  assert.equal(frontendInvocations.length, 7, frontendName);
  for (const [
    index,
    [beforeKey, afterKey, fixtureMarker],
  ] of assertions.entries()) {
    const beforeInvocation = frontendInvocations[index * 2];
    const afterInvocation = frontendInvocations[index * 2 + 1];

    assert.equal(beforeInvocation.fixture, null, frontendName);
    assert.equal(beforeInvocation[beforeKey], true, frontendName);
    assert.match(afterInvocation.fixture, new RegExp(fixtureMarker));
    assert.equal(afterInvocation[afterKey], true, frontendName);
  }
  assert.equal(frontendInvocations[6].fixture, null, frontendName);
}

test("verifies schema, React hook, and client export refreshes for every frontend", async () => {
  const { result, invocations } = await runRefreshCheck();
  const frontendNames = getRefreshFrontendNames(result.stdout);
  const frontendCount = frontendNames.length;

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    new RegExp(
      `All ${frontendCount} frontend\\(s\\) refreshed generated API schema, React hook, and client export assertions successfully\\.`,
    ),
  );
  assert.equal(result.stderr, "");
  assert.ok(frontendCount > 0);
  assert.deepEqual(frontendNamesFromInvocations(invocations), frontendNames);

  assert.equal(invocations.length, frontendCount * 7);
  assert.deepEqual(
    frontendNames,
    [...frontendNames].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    [...new Set(invocations.map(({ frontendName }) => frontendName))],
    frontendNames,
  );

  const surfaces = [
    {
      fixtureMarker: "const refreshedType",
      before: "schemaBefore",
      after: "schemaAfter",
    },
    {
      fixtureMarker: "const refreshedHookResult",
      before: "hookBefore",
      after: "hookAfter",
    },
    {
      fixtureMarker: "const refreshedMutationResult",
      before: "clientExportBefore",
      after: "clientExportAfter",
    },
  ];

  for (const [surfaceIndex, surface] of surfaces.entries()) {
    const invocationStart = surfaceIndex * frontendCount * 2;
    for (const [frontendIndex, frontendName] of frontendNames.entries()) {
      const beforeInvocation = invocations[invocationStart + frontendIndex];
      const afterInvocation =
        invocations[invocationStart + frontendCount + frontendIndex];

      assert.equal(beforeInvocation.frontendName, frontendName);
      assert.equal(beforeInvocation.fixture, null);
      assert.equal(beforeInvocation[surface.before], true);
      assert.equal(afterInvocation.frontendName, frontendName);
      assert.match(afterInvocation.fixture, new RegExp(surface.fixtureMarker));
      assert.equal(afterInvocation[surface.after], true);
    }
  }

  for (const [frontendIndex, invocation] of invocations
    .slice(-frontendCount)
    .entries()) {
    assert.equal(invocation.fixture, null);
    assert.equal(invocation.frontendName, frontendNames[frontendIndex]);
  }
});

test("keeps frontend consumers isolated and restores every fixture after success and failure", async () => {
  const originalSchema = await readFile(generatedSchemaPath, "utf8");
  const originalClient = await readFile(generatedClientPath, "utf8");
  const { invocations: baselineInvocations } = await runRefreshCheck();
  const baselineFrontends = frontendNamesFromInvocations(baselineInvocations);
  let existingFrontends = [];

  await withTemporaryFrontend(
    async ({ artifactPath, fixturePath, packageName }) => {
      const expectedFrontends = [...baselineFrontends, packageName].sort(
        (left, right) => left.localeCompare(right),
      );
      const { result, invocations } = await runRefreshCheck();
      const reportedFrontends = getRefreshFrontendNames(result.stdout);
      const frontendCount = expectedFrontends.length;
      existingFrontends = expectedFrontends.filter(
        (frontendName) => frontendName !== packageName,
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(reportedFrontends, expectedFrontends);
      assert.deepEqual(
        frontendNamesFromInvocations(invocations),
        expectedFrontends,
      );
      assert.match(
        result.stdout,
        new RegExp(
          `Checking generated API refreshes for ${frontendCount} frontend\\(s\\): `,
        ),
      );
      assert.match(
        result.stdout,
        new RegExp(
          `All ${frontendCount} frontend\\(s\\) refreshed generated API schema, React hook, and client export assertions successfully\\.`,
        ),
      );
      assert.equal(result.stderr, "");
      assert.ok(expectedFrontends.includes(packageName));
      assert.equal(invocations.length, frontendCount * 7);
      assert.ok(expectedFrontends.includes(packageName));
      assert.ok(expectedFrontends.includes("@workspace/top-dog-tricks"));

      const surfaces = [
        {
          fixtureMarker: "const refreshedType",
          before: "schemaBefore",
          after: "schemaAfter",
        },
        {
          fixtureMarker: "const refreshedHookResult",
          before: "hookBefore",
          after: "hookAfter",
        },
        {
          fixtureMarker: "const refreshedMutationResult",
          before: "clientExportBefore",
          after: "clientExportAfter",
        },
      ];

      for (const [surfaceIndex, surface] of surfaces.entries()) {
        const invocationStart = surfaceIndex * frontendCount * 2;
        for (const [
          frontendIndex,
          frontendName,
        ] of expectedFrontends.entries()) {
          const beforeInvocation = invocations[invocationStart + frontendIndex];
          const afterInvocation =
            invocations[invocationStart + frontendCount + frontendIndex];

          assert.equal(beforeInvocation.frontendName, frontendName);
          assert.equal(beforeInvocation.fixture, null);
          assert.equal(beforeInvocation[surface.before], true);

          assert.equal(afterInvocation.frontendName, frontendName);
          assert.match(
            afterInvocation.fixture,
            new RegExp(surface.fixtureMarker),
          );
          assert.equal(afterInvocation[surface.after], true);
        }
      }

      for (const [frontendIndex, invocation] of invocations
        .slice(-frontendCount)
        .entries()) {
        assert.equal(invocation.fixture, null);
        assert.equal(invocation.frontendName, expectedFrontends[frontendIndex]);
      }
      assert.equal(await fileExists(fixturePath), false);
      assert.equal(await fileExists(artifactPath), true);
      assert.equal(await readFile(generatedSchemaPath, "utf8"), originalSchema);
      assert.equal(await readFile(generatedClientPath, "utf8"), originalClient);
    },
  );

  await withTemporaryFrontend(
    async ({ artifactPath, fixturePath, packageName }) => {
      const expectedFrontends = [...baselineFrontends, packageName].sort(
        (left, right) => left.localeCompare(right),
      );
      const { result, invocations } = await runRefreshCheck({
        githubActions: "true",
        failureTarget: "React hook",
        failureFrontend: packageName,
        failurePhase: "after",
      });
      const reportedFrontends = getRefreshFrontendNames(result.stdout);
      const frontendCount = expectedFrontends.length;
      const failureIndex = expectedFrontends.indexOf(packageName);

      assert.notEqual(result.status, 0);
      assert.deepEqual(reportedFrontends, expectedFrontends);
      assert.equal(
        result.stderr.split("\n", 1)[0],
        `::error file=lib/api-client-react/src/generated/api.ts::Frontend ${packageName} typecheck failed while verifying the React hook generated API refresh assertion.%0Acompiler stderr for React hook%0A`,
      );
      assert.match(
        result.stderr,
        new RegExp(
          `Frontend ${packageName.replaceAll("/", "\\/")} typecheck failed while verifying the React hook generated API refresh assertion`,
        ),
      );
      assert.match(result.stderr, /compiler stdout for React hook/);
      assert.match(result.stderr, /compiler stderr for React hook/);
      assert.equal(invocations.length, frontendCount * 4 + failureIndex + 1);
      const failedInvocation = invocations.find(
        (invocation) =>
          invocation.frontendName === packageName &&
          invocation.fixture?.includes("const refreshedHookResult"),
      );
      assert.ok(failedInvocation);
      for (const invocation of invocations.slice(-frontendCount)) {
        assert.equal(invocation.fixture, null);
      }
      assert.equal(await fileExists(fixturePath), false);
      assert.equal(await fileExists(artifactPath), true);
      assert.equal(await readFile(generatedSchemaPath, "utf8"), originalSchema);
      assert.equal(await readFile(generatedClientPath, "utf8"), originalClient);
    },
  );

  const expectedFrontends = [...existingFrontends].sort((left, right) =>
    left.localeCompare(right),
  );
  const laterFrontend = expectedFrontends[1];
  const frontendFixturePaths = [
    "artifacts/ghost-town-rescue/src/api-client-refresh-regression.ts",
    "artifacts/top-dog-tricks/src/api-client-refresh-regression.ts",
  ].map((relativePath) => path.join(workspaceRoot, relativePath));

  assert.equal(expectedFrontends.length, 2);
  assert.equal(laterFrontend, "@workspace/top-dog-tricks");

  for (const githubActions of ["false", "true"]) {
    const { result, invocations } = await runRefreshCheck({
      githubActions,
      failureTarget: "React hook",
      failureFrontend: laterFrontend,
      failurePhase: "after",
    });

    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes(
        `Frontend ${laterFrontend} typecheck failed while verifying the React hook generated API refresh assertion`,
      ),
    );
    assert.match(result.stderr, /compiler stderr for React hook/);
    if (githubActions === "true") {
      assert.ok(
        result.stderr.includes(
          `::error file=lib/api-client-react/src/generated/api.ts::Frontend ${laterFrontend} typecheck failed while verifying the React hook generated API refresh assertion.`,
        ),
      );
    } else {
      assert.doesNotMatch(result.stderr, /::error file=/);
    }

    assert.equal(invocations.length, expectedFrontends.length * 5);
    const hookAfterStart = expectedFrontends.length * 3;
    const earlierConsumerInvocation = invocations[hookAfterStart];
    const laterConsumerInvocation = invocations[hookAfterStart + 1];
    assert.equal(earlierConsumerInvocation.frontendName, expectedFrontends[0]);
    assert.match(
      earlierConsumerInvocation.fixture,
      /const refreshedHookResult/,
    );
    assert.equal(laterConsumerInvocation.frontendName, laterFrontend);
    assert.match(laterConsumerInvocation.fixture, /const refreshedHookResult/);
    for (const [frontendIndex, invocation] of invocations
      .slice(-expectedFrontends.length)
      .entries()) {
      assert.equal(invocation.frontendName, expectedFrontends[frontendIndex]);
      assert.equal(invocation.fixture, null);
    }

    for (const fixturePath of frontendFixturePaths) {
      assert.equal(await fileExists(fixturePath), false);
    }
    assert.equal(await readFile(generatedSchemaPath, "utf8"), originalSchema);
    assert.equal(await readFile(generatedClientPath, "utf8"), originalClient);
  }
});

test("discovers API-client frontends from every supported dependency section", async () => {
  const { invocations: baselineInvocations } = await runRefreshCheck();
  const baselineFrontends = frontendNamesFromInvocations(baselineInvocations);

  for (const dependencySection of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    let temporaryArtifactPath;

    await withTemporaryFrontend(
      async ({ artifactPath, fixturePath, packageName }) => {
        temporaryArtifactPath = artifactPath;
        const expectedFrontends = [...baselineFrontends, packageName].sort(
          (left, right) => left.localeCompare(right),
        );
        const { result, invocations } = await runRefreshCheck();

        assert.equal(
          result.status,
          0,
          `${dependencySection}: ${result.stdout}\n${result.stderr}`,
        );
        assert.match(
          result.stdout,
          new RegExp(
            `Checking generated API refreshes for ${expectedFrontends.length} frontend\\(s\\): `,
          ),
        );
        assert.match(
          result.stdout,
          new RegExp(
            `All ${expectedFrontends.length} frontend\\(s\\) refreshed generated API schema, React hook, and client export assertions successfully\\.`,
          ),
        );
        assert.equal(result.stderr, "");
        assert.equal(
          invocations.length,
          expectedFrontends.length * 7,
          dependencySection,
        );
        assert.deepEqual(
          frontendNamesFromInvocations(invocations),
          expectedFrontends,
          dependencySection,
        );
        for (const frontendName of expectedFrontends) {
          assertFrontendRefreshCycle(invocations, frontendName);
        }
        assert.equal(await fileExists(fixturePath), false, dependencySection);
        assert.equal(await fileExists(artifactPath), true, dependencySection);
      },
      "artifacts",
      undefined,
      dependencySection,
    );

    assert.equal(
      await fileExists(temporaryArtifactPath),
      false,
      `${dependencySection} temporary frontend was not removed`,
    );
  }
});

test("discovers API-client frontends from workspace scopes outside artifacts", async () => {
  const { invocations: baselineInvocations } = await runRefreshCheck();
  const baselineFrontends = frontendNamesFromInvocations(baselineInvocations);

  await withTemporaryFrontend(
    async ({ artifactPath, fixturePath, packageName }) => {
      const expectedFrontends = [...baselineFrontends, packageName].sort(
        (left, right) => left.localeCompare(right),
      );
      const { result, invocations } = await runRefreshCheck();
      const reportedFrontends = getRefreshFrontendNames(result.stdout);
      const frontendCount = expectedFrontends.length;

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(reportedFrontends, expectedFrontends);
      assert.match(
        result.stdout,
        new RegExp(
          `Checking generated API refreshes for ${frontendCount} frontend\\(s\\): `,
        ),
      );
      assert.match(
        result.stdout,
        new RegExp(
          `All ${frontendCount} frontend\\(s\\) refreshed generated API schema, React hook, and client export assertions successfully\\.`,
        ),
      );
      assert.equal(result.stderr, "");
      assert.equal(invocations.length, frontendCount * 7);
      assert.ok(expectedFrontends.includes(packageName));
      assert.match(result.stdout, new RegExp(packageName));
      assert.equal(
        invocations.some(
          (invocation) => invocation.frontendName === packageName,
        ),
        true,
      );
      assert.deepEqual(
        frontendNamesFromInvocations(invocations),
        expectedFrontends,
      );
      for (const frontendName of expectedFrontends) {
        assertFrontendRefreshCycle(invocations, frontendName);
      }
      assert.equal(await fileExists(fixturePath), false);
      assert.equal(await fileExists(artifactPath), true);
    },
    "apps",
  );
});

test("keeps explicitly excluded non-frontend workspace packages out of the check", async () => {
  const { invocations: baselineInvocations } = await runRefreshCheck();
  const baselineFrontends = frontendNamesFromInvocations(baselineInvocations);

  await withTemporaryFrontend(
    async ({ artifactPath, fixturePath, packageName }) => {
      const { result, invocations } = await runRefreshCheck();
      const reportedFrontends = getRefreshFrontendNames(result.stdout);
      const frontendCount = reportedFrontends.length;

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(reportedFrontends, baselineFrontends);
      assert.match(
        result.stdout,
        new RegExp(
          `Checking generated API refreshes for ${frontendCount} frontend\\(s\\): `,
        ),
      );
      assert.equal(result.stderr, "");
      assert.ok(frontendCount >= 1);
      assert.ok(
        result.stdout.includes(`${baselineFrontends.join(", ")}.`),
        `Expected the refresh check to list ${baselineFrontends.join(", ")}.`,
      );
      assert.equal(invocations.length, frontendCount * 7);
      assert.deepEqual(
        frontendNamesFromInvocations(invocations),
        baselineFrontends,
      );
      assert.equal(reportedFrontends.includes(packageName), false);
      assert.equal(
        invocations.every(
          (invocation) => invocation.frontendName !== packageName,
        ),
        true,
      );
      for (const frontendName of baselineFrontends) {
        assertFrontendRefreshCycle(invocations, frontendName);
      }
      assert.equal(await fileExists(fixturePath), false);
      assert.equal(await fileExists(artifactPath), true);
    },
    "apps",
    "@workspace/api-server",
  );
});

test("links CI refresh failures to the generated schema or client file", async () => {
  const originalSchema = await readFile(generatedSchemaPath, "utf8");
  const originalClient = await readFile(generatedClientPath, "utf8");
  const cases = [
    {
      target: "schema",
      generatedPath: "lib/api-client-react/src/generated/api.schemas.ts",
    },
    {
      target: "React hook",
      generatedPath: "lib/api-client-react/src/generated/api.ts",
    },
    {
      target: "client export",
      generatedPath: "lib/api-client-react/src/generated/api.ts",
    },
  ];

  for (const { target, generatedPath } of cases) {
    const { result } = await runRefreshCheck({
      githubActions: "true",
      failureTarget: target,
    });

    assert.notEqual(result.status, 0, target);
    assert.equal(
      result.stderr.split("\n", 1)[0],
      `::error file=${generatedPath}::Frontend @workspace/top-dog-tricks typecheck failed while verifying the ${target} before-refresh generated API refresh assertion.%0Acompiler stderr for ${target}%0A`,
    );
    assert.match(result.stderr, new RegExp(`compiler stdout for ${target}`));
    assert.match(result.stderr, new RegExp(`compiler stderr for ${target}`));
    assert.equal(await readFile(generatedSchemaPath, "utf8"), originalSchema);
    assert.equal(await readFile(generatedClientPath, "utf8"), originalClient);
  }
});

test("escapes multiline compiler diagnostics in one CI annotation", async () => {
  const compilerDiagnostic =
    "error TS1005: 100% unexpected\r\n  second line\rfinal line\n";
  const { result } = await runRefreshCheck({
    githubActions: "true",
    failureTarget: "schema",
    failureDiagnostic: compilerDiagnostic,
  });

  assert.notEqual(result.status, 0);
  const escapedDiagnostic = compilerDiagnostic
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  const annotation =
    result.stderr.split("\n").find((line) => line.startsWith("::error ")) ?? "";
  assert.equal(
    annotation,
    `::error file=lib/api-client-react/src/generated/api.schemas.ts::Frontend @workspace/top-dog-tricks typecheck failed while verifying the schema before-refresh generated API refresh assertion.%0A${escapedDiagnostic}`,
  );
  assert.equal(
    result.stderr.split("\n").filter((line) => line.startsWith("::error "))
      .length,
    1,
  );
  assert.ok(result.stderr.includes(compilerDiagnostic));
});

test("keeps local multiline refresh diagnostics readable without a GitHub annotation", async () => {
  const compilerDiagnostic =
    "error TS1005: 100% unexpected\r\n  second line\rfinal line\n";
  const { result } = await runRefreshCheck({
    githubActions: "false",
    failureTarget: "schema",
    failureDiagnostic: compilerDiagnostic,
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(compilerDiagnostic));
  assert.match(
    result.stderr,
    /Frontend @workspace\/top-dog-tricks typecheck failed while verifying the schema before-refresh generated API refresh assertion/,
  );
  assert.doesNotMatch(result.stderr, /::error file=/);
  assert.doesNotMatch(result.stderr, /100%25 unexpected/);
});
