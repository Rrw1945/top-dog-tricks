import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const artifactDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function waitForFile(filePath: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

test("bundles and executes suites with the same basename in different directories", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["test.mjs"], {
      cwd: artifactDir,
      env: {
        ...childEnvironment,
        API_TEST_SOURCE_DIR: path.join(
          artifactDir,
          "test-fixtures",
          "same-basename",
        ),
        API_TEST_OUTPUT_DIR: outputDir,
      },
    });

    const runnerOutput = `${stdout}\n${stderr}`;
    assert.match(runnerOutput, /runs the first same-named fixture suite/);
    assert.match(runnerOutput, /runs the second same-named fixture suite/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});



test("removes temporary bundles when bundling fails", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const outputDir = path.join(temporaryRoot, "bundles");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  try {
    await assert.rejects(
      execFileAsync(process.execPath, ["test.mjs"], {
        cwd: artifactDir,
        env: {
          ...childEnvironment,
          API_TEST_SOURCE_DIR: path.join(
            artifactDir,
            "test-fixtures",
            "bundling-failure",
          ),
          API_TEST_OUTPUT_DIR: outputDir,
        },
      }),
      /Build failed/,
    );
    await assert.rejects(access(outputDir), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preserves a failed test outcome when cleanup also fails", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "failure.test.ts"),
    `import assert from "node:assert/strict";
import test from "node:test";

test("reports the original test failure", () => {
  assert.fail("original API test failure");
});
`,
  );

  try {
    await assert.rejects(
      execFileAsync(process.execPath, ["test.mjs"], {
        cwd: artifactDir,
        env: {
          ...childEnvironment,
          API_TEST_SOURCE_DIR: sourceDir,
          API_TEST_OUTPUT_DIR: outputDir,
          API_TEST_CLEANUP_FAILURE_MESSAGE: "simulated cleanup failure",
        },
      }),
      (error: Error & { code?: number; stdout?: string; stderr?: string }) => {
        const runnerOutput = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
        assert.equal(error.code, 1);
        assert.match(runnerOutput, /original API test failure/);
        assert.match(
          runnerOutput,
          /Failed to clean up API test bundles.*simulated cleanup failure/s,
        );
        assert.doesNotMatch(runnerOutput, /uncaughtException/);
        return true;
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("fails a successful test run when cleanup fails", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "success.test.ts"),
    `import test from "node:test";

test("passes before cleanup fails", () => {});
`,
  );

  try {
    await assert.rejects(
      execFileAsync(process.execPath, ["test.mjs"], {
        cwd: artifactDir,
        env: {
          ...childEnvironment,
          API_TEST_SOURCE_DIR: sourceDir,
          API_TEST_OUTPUT_DIR: outputDir,
          API_TEST_CLEANUP_FAILURE_MESSAGE: "simulated cleanup-only failure",
        },
      }),
      (error: Error & { code?: number; stdout?: string; stderr?: string }) => {
        const runnerOutput = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
        assert.equal(error.code, 1);
        assert.match(runnerOutput, /passes before cleanup fails/);
        assert.match(
          runnerOutput,
          new RegExp(
            `Failed to clean up API test bundles in ${outputDir.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&",
            )}`,
          ),
        );
        assert.match(runnerOutput, /simulated cleanup-only failure/);
        return true;
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("removes temporary bundles and preserves SIGTERM interruption", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "ready");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import { writeFile } from "node:fs/promises";
import test from "node:test";

test("waits to be interrupted", async () => {
  await writeFile(process.env.API_TEST_READY_FILE!, "");
  await new Promise(() => {});
});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_READY_FILE: readyFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");

  try {
    await waitForFile(readyFile);
    runner.kill("SIGTERM");

    const [code, signal] = await runnerExit;
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    await assert.rejects(access(outputDir), { code: "ENOENT" });
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preserves SIGTERM when cancellation cleanup stalls", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "ready");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import { writeFile } from "node:fs/promises";
import test from "node:test";

test("waits to be interrupted", async () => {
  await writeFile(process.env.API_TEST_READY_FILE!, "");
  await new Promise(() => {});
});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_READY_FILE: readyFile,
      API_TEST_STALL_CLEANUP: "1",
      API_TEST_CANCELLATION_CLEANUP_TIMEOUT_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");

  try {
    await waitForFile(readyFile);
    runner.kill("SIGTERM");

    const [code, signal] = await Promise.race([
      runnerExit,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Runner did not exit after cleanup timed out")),
          2_000,
        );
      }),
    ]);
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preserves SIGINT when cancellation cleanup stalls", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "ready");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import { writeFile } from "node:fs/promises";
import test from "node:test";

test("waits to be interrupted", async () => {
  await writeFile(process.env.API_TEST_READY_FILE!, "");
  await new Promise(() => {});
});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_READY_FILE: readyFile,
      API_TEST_STALL_CLEANUP: "1",
      API_TEST_CANCELLATION_CLEANUP_TIMEOUT_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");

  try {
    await waitForFile(readyFile);
    runner.kill("SIGINT");

    const [code, signal] = await Promise.race([
      runnerExit,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Runner did not exit after cleanup timed out")),
          2_000,
        );
      }),
    ]);
    assert.equal(code, null);
    assert.equal(signal, "SIGINT");
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("reports cancellation cleanup failure while preserving SIGTERM", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "ready");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import { writeFile } from "node:fs/promises";
import test from "node:test";

test("waits to be interrupted", async () => {
  await writeFile(process.env.API_TEST_READY_FILE!, "");
  await new Promise(() => {});
});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_READY_FILE: readyFile,
      API_TEST_CLEANUP_FAILURE_MESSAGE: "simulated interrupted cleanup failure",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");
  let stderr = "";
  runner.stderr.setEncoding("utf8");
  runner.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForFile(readyFile);
    runner.kill("SIGTERM");

    const [code, signal] = await runnerExit;
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    assert.match(
      stderr,
      new RegExp(
        `Failed to clean up API test bundles in ${outputDir.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}`,
      ),
    );
    assert.match(stderr, /simulated interrupted cleanup failure/);
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("reports cancellation cleanup failure while preserving SIGINT", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "ready");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import { writeFile } from "node:fs/promises";
import test from "node:test";

test("waits to be interrupted", async () => {
  await writeFile(process.env.API_TEST_READY_FILE!, "");
  await new Promise(() => {});
});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_READY_FILE: readyFile,
      API_TEST_CLEANUP_FAILURE_MESSAGE: "simulated interrupted cleanup failure",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");
  let stderr = "";
  runner.stderr.setEncoding("utf8");
  runner.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForFile(readyFile);
    runner.kill("SIGINT");

    const [code, signal] = await runnerExit;
    assert.equal(code, null);
    assert.equal(signal, "SIGINT");
    assert.match(
      stderr,
      new RegExp(
        `Failed to clean up API test bundles in ${outputDir.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}`,
      ),
    );
    assert.match(stderr, /simulated interrupted cleanup failure/);
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runs cancellation cleanup once when SIGINT repeats", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "ready");
  const cleanupReadyFile = path.join(temporaryRoot, "cleanup-ready");
  const cleanupReleaseFile = path.join(temporaryRoot, "cleanup-release");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import { writeFile } from "node:fs/promises";
import test from "node:test";

test("waits to be interrupted", async () => {
  await writeFile(process.env.API_TEST_READY_FILE!, "");
  await new Promise(() => {});
});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_READY_FILE: readyFile,
      API_TEST_CLEANUP_READY_FILE: cleanupReadyFile,
      API_TEST_CLEANUP_RELEASE_FILE: cleanupReleaseFile,
      API_TEST_CLEANUP_FAILURE_MESSAGE: "simulated repeated SIGINT cleanup failure",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");
  const stderrClosed = once(runner.stderr, "close");
  let stderr = "";
  runner.stderr.setEncoding("utf8");
  runner.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForFile(readyFile);
    runner.kill("SIGINT");
    await waitForFile(cleanupReadyFile);
    runner.kill("SIGINT");
    await writeFile(cleanupReleaseFile, "");

    const [code, signal] = await runnerExit;
    await stderrClosed;
    assert.equal(code, null);
    assert.equal(signal, "SIGINT");
    await assert.rejects(access(outputDir), { code: "ENOENT" });
    assert.equal(
      stderr.match(/Failed to clean up API test bundles/g)?.length,
      1,
    );
    assert.match(stderr, /simulated repeated SIGINT cleanup failure/);
    assert.doesNotMatch(stderr, /uncaughtException/);
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runs cancellation cleanup once when SIGTERM repeats", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "ready");
  const cleanupReadyFile = path.join(temporaryRoot, "cleanup-ready");
  const cleanupReleaseFile = path.join(temporaryRoot, "cleanup-release");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import { writeFile } from "node:fs/promises";
import test from "node:test";

test("waits to be interrupted", async () => {
  await writeFile(process.env.API_TEST_READY_FILE!, "");
  await new Promise(() => {});
});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_READY_FILE: readyFile,
      API_TEST_CLEANUP_READY_FILE: cleanupReadyFile,
      API_TEST_CLEANUP_RELEASE_FILE: cleanupReleaseFile,
      API_TEST_CLEANUP_FAILURE_MESSAGE: "simulated repeated SIGTERM cleanup failure",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");
  const stderrClosed = once(runner.stderr, "close");
  let stderr = "";
  runner.stderr.setEncoding("utf8");
  runner.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForFile(readyFile);
    runner.kill("SIGTERM");
    await waitForFile(cleanupReadyFile);
    runner.kill("SIGTERM");
    await writeFile(cleanupReleaseFile, "");

    const [code, signal] = await runnerExit;
    await stderrClosed;
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    await assert.rejects(access(outputDir), { code: "ENOENT" });
    assert.equal(
      stderr.match(/Failed to clean up API test bundles/g)?.length,
      1,
    );
    assert.match(stderr, /simulated repeated SIGTERM cleanup failure/);
    assert.doesNotMatch(stderr, /uncaughtException/);
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("removes partial bundles and preserves SIGTERM while bundling", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "bundling-ready");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import test from "node:test";

test("would run after bundling", () => {});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_BUNDLE_READY_FILE: readyFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");

  try {
    await waitForFile(readyFile);
    await access(path.join(outputDir, "partial-bundle.mjs"));
    runner.kill("SIGTERM");

    const [code, signal] = await runnerExit;
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    await assert.rejects(access(outputDir), { code: "ENOENT" });
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("reports bundling cleanup failure once while preserving SIGTERM", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "bundling-ready");
  const cleanupReadyFile = path.join(temporaryRoot, "cleanup-ready");
  const releaseFile = path.join(temporaryRoot, "release");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import test from "node:test";

test("would run after bundling", () => {});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_BUNDLE_READY_FILE: readyFile,
      API_TEST_BUNDLE_RELEASE_FILE: releaseFile,
      API_TEST_BUNDLE_FAILURE_MESSAGE: "simulated bundling failure",
      API_TEST_CLEANUP_READY_FILE: cleanupReadyFile,
      API_TEST_CLEANUP_RELEASE_FILE: releaseFile,
      API_TEST_CLEANUP_FAILURE_MESSAGE: "simulated bundling cleanup failure",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");
  const stderrClosed = once(runner.stderr, "close");
  let stderr = "";
  runner.stderr.setEncoding("utf8");
  runner.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForFile(readyFile);
    await access(path.join(outputDir, "partial-bundle.mjs"));
    runner.kill("SIGTERM");
    await waitForFile(cleanupReadyFile);
    await writeFile(releaseFile, "");

    const [code, signal] = await runnerExit;
    await stderrClosed;
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    await assert.rejects(access(outputDir), { code: "ENOENT" });
    assert.equal(
      stderr.match(/Failed to clean up API test bundles/g)?.length,
      1,
    );
    assert.match(stderr, /simulated bundling cleanup failure/);
    assert.doesNotMatch(stderr, /uncaughtException/);
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("removes partial bundles and preserves SIGINT while bundling", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const outputDir = path.join(temporaryRoot, "bundles");
  const readyFile = path.join(temporaryRoot, "bundling-ready");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "interrupted.test.ts"),
    `import test from "node:test";

test("would run after bundling", () => {});
`,
  );

  const runner = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OUTPUT_DIR: outputDir,
      API_TEST_BUNDLE_READY_FILE: readyFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runnerExit = once(runner, "exit");

  try {
    await waitForFile(readyFile);
    await access(path.join(outputDir, "partial-bundle.mjs"));
    runner.kill("SIGINT");

    const [code, signal] = await runnerExit;
    assert.equal(code, null);
    assert.equal(signal, "SIGINT");
    await assert.rejects(access(outputDir), { code: "ENOENT" });
  } finally {
    runner.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("overlapping default runner invocations keep their bundles isolated", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "api-test-runner-"));
  const sourceDir = path.join(temporaryRoot, "source");
  const readyFile = path.join(temporaryRoot, "first-ready");
  const releaseFile = path.join(temporaryRoot, "release-first");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "overlap.test.ts"),
    `import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("keeps this invocation's bundle available", async () => {
  if (process.env.API_TEST_OVERLAP_ROLE !== "first") return;
  await writeFile(process.env.API_TEST_READY_FILE!, "");
  while (true) {
    try {
      await access(process.env.API_TEST_RELEASE_FILE!);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await assert.doesNotReject(access(fileURLToPath(import.meta.url)));
});
`,
  );

  const first = spawn(process.execPath, ["test.mjs"], {
    cwd: artifactDir,
    env: {
      ...childEnvironment,
      API_TEST_SOURCE_DIR: sourceDir,
      API_TEST_OVERLAP_ROLE: "first",
      API_TEST_READY_FILE: readyFile,
      API_TEST_RELEASE_FILE: releaseFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const firstExit = once(first, "exit");

  try {
    await waitForFile(readyFile);
    await execFileAsync(process.execPath, ["test.mjs"], {
      cwd: artifactDir,
      env: {
        ...childEnvironment,
        API_TEST_SOURCE_DIR: sourceDir,
        API_TEST_OVERLAP_ROLE: "second",
      },
    });
    await writeFile(releaseFile, "");

    const [code] = await firstExit;
    assert.equal(code, 0);
  } finally {
    first.kill();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
