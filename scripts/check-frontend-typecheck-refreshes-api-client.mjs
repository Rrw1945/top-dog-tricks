import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const generatedSource = path.join(
  workspaceRoot,
  "lib/api-client-react/src/generated/api.schemas.ts",
);
const generatedReactClient = path.join(
  workspaceRoot,
  "lib/api-client-react/src/generated/api.ts",
);
const frontendFixture = path.join(
  workspaceRoot,
  "artifacts/top-dog-tricks/src/api-client-refresh-regression.ts",
);
const originalSource = await readFile(generatedSource, "utf8");
const originalReactClient = await readFile(generatedReactClient, "utf8");

function runFrontendTypecheck() {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@workspace/top-dog-tricks", "run", "typecheck"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`Frontend typecheck exited with status ${result.status}`);
  }
}

const markerName = "FrontendTypecheckRefreshRegression";
const hookName = "useFrontendTypecheckRefreshRegression";

try {
  await writeFile(
    generatedSource,
    `${originalSource}\nexport type ${markerName} = "before";\n`,
  );
  await writeFile(
    generatedReactClient,
    `${originalReactClient}\nexport const ${hookName} = (): "before" => "before";\n`,
  );
  runFrontendTypecheck();

  await writeFile(
    generatedSource,
    `${originalSource}\nexport type ${markerName} = "after";\n`,
  );
  await writeFile(
    generatedReactClient,
    `${originalReactClient}\nexport const ${hookName} = (): "after" => "after";\n`,
  );
  await writeFile(
    frontendFixture,
    `import { ${hookName} } from "@workspace/api-client-react";\nimport type { ${markerName} } from "@workspace/api-client-react";\n\nconst refreshedType: ${markerName} = "after";\nconst refreshedHookResult: ReturnType<typeof ${hookName}> = "after";\nvoid refreshedType;\nvoid refreshedHookResult;\n`,
  );

  runFrontendTypecheck();
  console.log(
    "Frontend typecheck refreshed changed API client schemas and React hooks successfully.",
  );
} finally {
  await writeFile(generatedSource, originalSource);
  await writeFile(generatedReactClient, originalReactClient);
  await rm(frontendFixture, { force: true });
  runFrontendTypecheck();
}