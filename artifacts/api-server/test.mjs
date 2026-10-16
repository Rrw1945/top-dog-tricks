import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { discoverTestEntries } from "./test-discovery.mjs";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = process.env.API_TEST_SOURCE_DIR
  ? path.resolve(process.env.API_TEST_SOURCE_DIR)
  : path.join(artifactDir, "src");
const requestedTestFile = process.env.API_TEST_FILE;
const testEntries =
  requestedTestFile === undefined
    ? await discoverTestEntries(sourceDir)
    : await (async () => {
        if (requestedTestFile.trim() === "") {
          throw new Error(
            `API_TEST_FILE must name one test file inside ${sourceDir}; received an empty value`,
          );
        }

        const absoluteTestFile = path.resolve(artifactDir, requestedTestFile);
        const relativeTestFile = path.relative(sourceDir, absoluteTestFile);
        if (
          relativeTestFile === "" ||
          relativeTestFile.startsWith("..") ||
          path.isAbsolute(relativeTestFile)
        ) {
          throw new Error(
            `API_TEST_FILE must identify a test file inside ${sourceDir}: ${requestedTestFile}`,
          );
        }

        const discoveredTestEntries = await discoverTestEntries(sourceDir);
        if (!discoveredTestEntries.includes(relativeTestFile)) {
          throw new Error(
            `API_TEST_FILE must match an existing .test.ts file inside ${sourceDir}: ${requestedTestFile}`,
          );
        }

        return [relativeTestFile];
      })();
const outputDir = process.env.API_TEST_OUTPUT_DIR
  ? path.resolve(process.env.API_TEST_OUTPUT_DIR)
  : await mkdtemp(path.join(artifactDir, ".test-dist-"));
const cancellationCleanupTimeoutMs = Number.parseInt(
  process.env.API_TEST_CANCELLATION_CLEANUP_TIMEOUT_MS ?? "5000",
  10,
);
const bundlingInterruptionPlugin = process.env.API_TEST_BUNDLE_READY_FILE
  ? {
      name: "test-bundling-interruption",
      setup(build) {
        build.onStart(async () => {
          await mkdir(outputDir, { recursive: true });
          await writeFile(
            path.join(outputDir, "partial-bundle.mjs"),
            "partial bundle output",
          );
          await writeFile(process.env.API_TEST_BUNDLE_READY_FILE, "");
          if (process.env.API_TEST_BUNDLE_RELEASE_FILE) {
            while (true) {
              try {
                await access(process.env.API_TEST_BUNDLE_RELEASE_FILE);
                break;
              } catch (error) {
                if (error?.code !== "ENOENT") throw error;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }
          }
          if (process.env.API_TEST_BUNDLE_FAILURE_MESSAGE) {
            throw new Error(process.env.API_TEST_BUNDLE_FAILURE_MESSAGE);
          }
          await new Promise(() => {});
        });
      },
    }
  : undefined;

if (testEntries.length === 0) {
  throw new Error(
    `No test files matching src/**/*.test.ts found in ${artifactDir}`,
  );
}

let runError;
let child;
let cleanupPromise;
let interrupted = false;
let cleanupErrorReported = false;

function reportCleanupError(cleanupError) {
  if (cleanupErrorReported) return;
  cleanupErrorReported = true;
  console.error(
    `Failed to clean up API test bundles in ${outputDir}:`,
    cleanupError,
  );
}

function cleanup() {
  cleanupPromise ??= (async () => {
    if (process.env.API_TEST_STALL_CLEANUP === "1") {
      await new Promise(() => {});
    }
    if (process.env.API_TEST_CLEANUP_READY_FILE) {
      await writeFile(process.env.API_TEST_CLEANUP_READY_FILE, "");
      if (process.env.API_TEST_CLEANUP_RELEASE_FILE) {
        while (true) {
          try {
            await access(process.env.API_TEST_CLEANUP_RELEASE_FILE);
            break;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }
    }
    await rm(outputDir, { recursive: true, force: true });
    if (process.env.API_TEST_CLEANUP_FAILURE_MESSAGE) {
      throw new Error(process.env.API_TEST_CLEANUP_FAILURE_MESSAGE);
    }
  })();
  return cleanupPromise;
}

async function cleanupBeforeCancellation() {
  let timeout;
  try {
    await Promise.race([
      cleanup(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Cleanup did not finish within ${cancellationCleanupTimeoutMs}ms`,
            ),
          );
        }, cancellationCleanupTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleSignal(signal) {
  if (interrupted) return;
  interrupted = true;
  child?.kill(signal);

  try {
    await cleanupBeforeCancellation();
  } catch (cleanupError) {
    reportCleanupError(cleanupError);
  } finally {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void handleSignal(signal);
  });
}

try {
  await rm(outputDir, { recursive: true, force: true });
  for (const entry of testEntries) {
    const outputFile = path.join(outputDir, entry.replace(/\.ts$/, ".mjs"));
    await build({
      entryPoints: [path.join(sourceDir, entry)],
      outfile: outputFile,
      bundle: true,
      platform: "node",
      format: "esm",
      sourcemap: "inline",
      logLevel: "warning",
      plugins: bundlingInterruptionPlugin ? [bundlingInterruptionPlugin] : [],
      banner: {
        js: `import { createRequire as __createRequire } from "node:module";
import __bannerPath from "node:path";
import __bannerUrl from "node:url";

globalThis.require = __createRequire(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);`,
      },
      external: ["@google-cloud/storage", "@replit/connectors-sdk"],
    });
  }

  child = spawn(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      ...testEntries.map((entry) =>
        path.join(outputDir, entry.replace(/\.ts$/, ".mjs")),
      ),
    ],
    {
      stdio: "inherit",
    },
  );

  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
  if (process.exitCode !== 0) {
    runError = new Error(`API tests exited with code ${process.exitCode}`);
  }
} catch (error) {
  runError = error;
  throw error;
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!runError && !interrupted) {
      throw new Error(`Failed to clean up API test bundles in ${outputDir}`, {
        cause: cleanupError,
      });
    }
    reportCleanupError(cleanupError);
  }
}
