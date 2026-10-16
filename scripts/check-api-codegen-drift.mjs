import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
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
const apiClientMutatorPath = path.join(
  workspaceRoot,
  "lib/api-client-react/src/custom-fetch.ts",
);

function workspaceRelativePath(filePath) {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

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

function changedFiles(committed, regenerated) {
  const changed = new Set([...committed.keys(), ...regenerated.keys()]);

  return [...changed]
    .filter((relativePath) => {
      const committedContents = committed.get(relativePath);
      const regeneratedContents = regenerated.get(relativePath);

      return (
        committedContents === undefined ||
        regeneratedContents === undefined ||
        !committedContents.equals(regeneratedContents)
      );
    })
    .sort();
}

function runCodegen(outputRoot) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    pnpm,
    [
      "--filter",
      "@workspace/api-spec",
      "exec",
      "orval",
      "--config",
      "./orval.config.ts",
    ],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        ORVAL_OUTPUT_ROOT: outputRoot,
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw new Error(
      `API code generation could not start: ${result.error.message}`,
      { cause: result.error },
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `API code generation failed with exit status ${result.status}.`,
    );
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "api-codegen-drift-"),
  );

  try {
    const temporaryMutatorPath = path.join(
      temporaryRoot,
      "lib/api-client-react/src/custom-fetch.ts",
    );
    await mkdir(path.dirname(temporaryMutatorPath), { recursive: true });
    await copyFile(apiClientMutatorPath, temporaryMutatorPath);
    await runCodegen(temporaryRoot);

    const drift = [];
    for (const surface of generatedSurfaces) {
      const committedPath = path.join(workspaceRoot, surface.relativePath);
      const regeneratedPath = path.join(temporaryRoot, surface.relativePath);
      const changed = changedFiles(
        await snapshotDirectory(committedPath),
        await snapshotDirectory(regeneratedPath),
      );

      if (changed.length > 0) {
        drift.push({ ...surface, changed });
      }
    }

    if (drift.length > 0) {
      process.stderr.write(
        [
          "Generated API code is out of date.",
          `Source spec: ${workspaceRelativePath(apiSpecPath)}`,
          ...drift.map(({ label, relativePath, changed }) =>
            [
              `Generated surface: ${relativePath} (${label})`,
              ...changed.map((filePath) => `  - ${filePath}`),
            ].join("\n"),
          ),
          "Run `pnpm --filter @workspace/api-spec run codegen` and commit the generated files.",
        ].join("\n") + "\n",
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `Generated API code matches ${workspaceRelativePath(apiSpecPath)}.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
