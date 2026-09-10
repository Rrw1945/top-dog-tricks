import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error The test runner helper is intentionally plain JavaScript.
import { discoverTestEntries } from "../../test-discovery.mjs";

test("discovers a newly added matching test file recursively", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "api-test-discovery-"));

  try {
    await mkdir(path.join(rootDir, "new", "nested"), { recursive: true });
    await writeFile(path.join(rootDir, "existing.test.ts"), "");
    await writeFile(path.join(rootDir, "new", "nested", "automatic.test.ts"), "");
    await writeFile(path.join(rootDir, "new", "nested", "ignored.spec.ts"), "");

    assert.deepEqual(await discoverTestEntries(rootDir), [
      "existing.test.ts",
      path.join("new", "nested", "automatic.test.ts"),
    ]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});