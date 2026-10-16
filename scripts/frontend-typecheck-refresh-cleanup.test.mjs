import assert from "node:assert/strict";
import {
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
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createCleanupAggregateError,
  createCleanupFailure,
  describeCleanupFailures,
} from "./frontend-typecheck-refresh-cleanup.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

test("describes every simultaneous refresh-check cleanup failure", () => {
  const schemaRestoration = createCleanupFailure(
    "Generated schema restoration",
    new Error("schema restore failed"),
  );
  const clientRestoration = createCleanupFailure(
    "Generated client restoration",
    new Error("client restore failed"),
  );
  const fixtureRemoval = createCleanupFailure(
    "Fixture removal for @workspace/top-dog-tricks",
    new Error("fixture removal failed"),
  );
  const cleanupTypecheck = createCleanupFailure(
    "Cleanup typecheck for @workspace/top-dog-tricks",
    new Error("cleanup typecheck failed"),
  );
  const cleanupFailure = createCleanupAggregateError(
    "Frontend refresh-check cleanup failed.",
    [
      createCleanupAggregateError(
        "Failed to restore one or more frontend refresh-check files.",
        [schemaRestoration, clientRestoration, fixtureRemoval],
      ),
      createCleanupAggregateError(
        "One or more frontend cleanup typechecks failed.",
        [cleanupTypecheck],
      ),
    ],
  );

  const description = describeCleanupFailures(cleanupFailure);

  assert.match(description, /Generated schema restoration failed/);
  assert.match(description, /Generated client restoration failed/);
  assert.match(
    description,
    /Fixture removal for @workspace\/top-dog-tricks failed/,
  );
  assert.match(
    description,
    /Cleanup typecheck for @workspace\/top-dog-tricks failed/,
  );
  assert.doesNotMatch(
    description,
    /Failed to restore one or more frontend refresh-check files/,
  );
  assert.doesNotMatch(
    description,
    /One or more frontend cleanup typechecks failed/,
  );
});

test("keeps the refresh validation error primary when restoration and cleanup typechecking fail", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "frontend-refresh-cleanup-failure-"),
  );
  const scriptDirectory = path.join(temporaryRoot, "scripts");
  const generatedDirectory = path.join(
    temporaryRoot,
    "lib/api-client-react/src/generated",
  );
  const frontendDirectory = path.join(
    temporaryRoot,
    "artifacts/refresh-test-frontend",
  );
  const fakeBin = path.join(temporaryRoot, "bin");
  const checkerPath = path.join(
    scriptDirectory,
    "check-frontend-typecheck-refreshes-api-client.mjs",
  );
  const generatedSchemaPath = path.join(generatedDirectory, "api.schemas.ts");
  const invocationsPath = path.join(temporaryRoot, "pnpm-invocations.txt");

  const fakePnpmSource = `#!/usr/bin/env node
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const count = Number(readFileSync(process.env.REFRESH_TEST_INVOCATIONS, "utf8")) + 1;
writeFileSync(process.env.REFRESH_TEST_INVOCATIONS, String(count));

if (count === 2) {
  rmSync(process.env.REFRESH_TEST_GENERATED_SCHEMA, { force: true });
  mkdirSync(process.env.REFRESH_TEST_GENERATED_SCHEMA);
  process.stderr.write("refresh assertion failed\\n");
  process.exitCode = 1;
} else if (count === 3) {
  process.stderr.write("cleanup typecheck failed\\n");
  process.exitCode = 1;
}
`;

  try {
    await Promise.all([
      mkdir(scriptDirectory, { recursive: true }),
      mkdir(generatedDirectory, { recursive: true }),
      mkdir(path.join(frontendDirectory, "src"), { recursive: true }),
      mkdir(fakeBin, { recursive: true }),
    ]);

    await Promise.all([
      readFile(
        path.join(
          scriptsDirectory,
          "check-frontend-typecheck-refreshes-api-client.mjs",
        ),
        "utf8",
      ).then((content) => writeFile(checkerPath, content)),
      readFile(
        path.join(scriptsDirectory, "frontend-typecheck-refresh-cleanup.mjs"),
        "utf8",
      ).then((content) =>
        writeFile(
          path.join(scriptDirectory, "frontend-typecheck-refresh-cleanup.mjs"),
          content,
        ),
      ),
      writeFile(
        path.join(temporaryRoot, "pnpm-workspace.yaml"),
        `packages:
  - "artifacts/*"
`,
      ),
      writeFile(
        path.join(temporaryRoot, "package.json"),
        JSON.stringify({ name: "refresh-cleanup-test-root" }),
      ),
      writeFile(
        path.join(frontendDirectory, "package.json"),
        JSON.stringify({
          name: "@workspace/refresh-test-frontend",
          dependencies: { "@workspace/api-client-react": "workspace:*" },
          scripts: { typecheck: "node -e 'process.exit(0)'" },
        }),
      ),
      writeFile(generatedSchemaPath, "export type OriginalSchema = string;"),
      writeFile(
        path.join(generatedDirectory, "api.ts"),
        "export type OriginalClient = string;",
      ),
      writeFile(invocationsPath, "0"),
      writeFile(path.join(fakeBin, "pnpm"), fakePnpmSource),
    ]);
    await chmod(path.join(fakeBin, "pnpm"), 0o755);

    const result = spawnSync(process.execPath, [checkerPath], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        REFRESH_TEST_GENERATED_SCHEMA: generatedSchemaPath,
        REFRESH_TEST_INVOCATIONS: invocationsPath,
      },
    });
    const stderr = result.stderr ?? "";
    const primaryFailure =
      "Error: Frontend @workspace/refresh-test-frontend typecheck failed while verifying the schema generated API refresh assertion (exit status 1).";

    assert.equal(result.status, 1, `${result.stdout}\n${stderr}`);
    assert.match(stderr, /refresh assertion failed/);
    assert.match(stderr, /Generated schema restoration failed:/);
    assert.match(
      stderr,
      /Cleanup typecheck for @workspace\/refresh-test-frontend failed:/,
    );
    assert.match(stderr, /cleanup typecheck failed/);
    assert.ok(
      stderr.lastIndexOf(primaryFailure) >
        stderr.indexOf(
          "Frontend refresh-check cleanup failed after the original validation failure:",
        ),
      "the uncaught process error should remain the original refresh validation failure",
    );
    assert.equal(await readFile(invocationsPath, "utf8"), "3");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
