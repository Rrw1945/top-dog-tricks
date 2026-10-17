import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const apiSpecPath = path.join(workspaceRoot, "lib/api-spec/openapi.yaml");
const generatedSurfaces = [
  {
    label: "React API client",
    relativePath: "lib/api-client-react/src/generated",
  },
  {
    label: "Zod API schemas",
    relativePath: "lib/api-zod/src/generated",
  },
];

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

async function snapshotDirectory(directory) {
  const snapshot = new Map();

  for (const filePath of await listFiles(directory)) {
    snapshot.set(
      path.relative(directory, filePath).split(path.sep).join("/"),
      await readFile(filePath),
    );
  }

  return snapshot;
}

async function listDriftTemporaryWorkspaces() {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith("api-codegen-drift-"),
    )
    .map((entry) => entry.name)
    .sort();
}

test("reports every stale generated API surface and cleans up after drift", async () => {
  const originalSpec = await readFile(apiSpecPath);
  const originalSpecText = originalSpec.toString("utf8");
  const healthStatusSchema = `    HealthStatus:
      type: object
      properties:
        status:
          type: string
      required:
        - status`;
  const changedHealthStatusSchema = `    HealthStatus:
      type: object
      properties:
        status:
          type: string
        driftDiagnosticSentinel:
          type: string
      required:
        - status`;

  assert.ok(
    originalSpecText.includes(healthStatusSchema),
    "Expected the OpenAPI health response schema to match the test fixture.",
  );
  const changedSpec = originalSpecText.replace(
    healthStatusSchema,
    changedHealthStatusSchema,
  );
  assert.notEqual(changedSpec, originalSpecText);

  const generatedSnapshots = new Map();
  for (const surface of generatedSurfaces) {
    generatedSnapshots.set(
      surface.relativePath,
      await snapshotDirectory(path.join(workspaceRoot, surface.relativePath)),
    );
  }
  const temporaryWorkspacesBefore = await listDriftTemporaryWorkspaces();

  let result;
  try {
    await writeFile(apiSpecPath, changedSpec);
    const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    result = spawnSync(packageManager, ["run", "check:api-codegen-drift"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 300_000,
    });
  } finally {
    await writeFile(apiSpecPath, originalSpec);
  }

  const stderr = result?.stderr ?? "";
  assert.equal(
    result?.error,
    undefined,
    `Could not run the API drift check: ${result?.error?.message ?? ""}`,
  );
  assert.equal(
    result?.status,
    1,
    `Expected the API drift check to fail after the controlled spec change.\n${result?.stdout ?? ""}\n${stderr}`,
  );
  assert.match(stderr, /Generated API code is out of date\./);
  assert.match(stderr, /Source spec: lib\/api-spec\/openapi\.yaml/);

  for (const surface of generatedSurfaces) {
    const diagnosticHeader = `Generated surface: ${surface.relativePath} (${surface.label})`;
    const diagnosticLines = stderr.split(/\r?\n/u);
    const headerIndex = diagnosticLines.indexOf(diagnosticHeader);
    assert.notEqual(
      headerIndex,
      -1,
      `Expected drift diagnostics to identify ${surface.relativePath}.\n${stderr}`,
    );
    assert.match(
      diagnosticLines[headerIndex + 1] ?? "",
      /^  - .+/u,
      `Expected changed generated files to be listed for ${surface.relativePath}.\n${stderr}`,
    );

    assert.deepEqual(
      await snapshotDirectory(path.join(workspaceRoot, surface.relativePath)),
      generatedSnapshots.get(surface.relativePath),
      `The drift check changed committed output in ${surface.relativePath}.`,
    );
  }

  assert.deepEqual(
    await listDriftTemporaryWorkspaces(),
    temporaryWorkspacesBefore,
    "The drift check left a temporary workspace behind.",
  );
  assert.deepEqual(
    await readFile(apiSpecPath),
    originalSpec,
    "The test did not restore the OpenAPI source file.",
  );
});
