import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { uploadCleanupHealthStore } from "./uploadCleanupHealthStore";
import { parseCleanupOptions, reportUploadCleanup, type CleanupHealth } from "./uploadCleanupReporting";

test("cleanup reporting persists aggregate failures, warns at threshold, and resets only on healthy apply", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A temp table shadows the real singleton; no production operational state changes.
    await client.query(`CREATE TEMP TABLE entry_upload_cleanup_health
      (LIKE public.entry_upload_cleanup_health INCLUDING ALL) ON COMMIT DROP`);
    await client.query("INSERT INTO entry_upload_cleanup_health (id) VALUES (1)");
    const store = uploadCleanupHealthStore(client);
    const logs: any[] = [];
    let outcome: Record<string, number> = { failed: 2, deleted: 1 };
    let throwRun = false;
    let runs = 0;
    const deps = {
      ...store,
      readFences: async () => 0,
      run: async () => { runs++; if (throwRun) throw new Error("private-path secret entrant"); return outcome; },
      log: (level: string, data: object, message: string) => { logs.push({ level, data, message }); },
    };
    for (let i = 0; i < 3; i++) assert.equal(await reportUploadCleanup(["--apply"], deps), 1);
    assert.equal(logs.at(-1).level, "warn");
    assert.equal(logs.at(-1).data.event, "entry_upload_cleanup_alert");
    // A new store instance sees the same durable state.
    let health = await uploadCleanupHealthStore(client).read();
    assert.equal(health.failedObjects, 6);
    assert.equal(health.failedRuns, 3);
    assert.equal(health.consecutiveFailures, 3);
    assert.ok(health.lastFailureAt);
    outcome = { deleted: 2, "private-path secret entrant": 99 };
    await reportUploadCleanup([], deps);
    assert.deepEqual(await store.read(), health);
    const beforeStatus = runs;
    assert.equal(await reportUploadCleanup(["--status"], deps), 1);
    assert.equal(runs, beforeStatus);
    assert.equal(await reportUploadCleanup(["--status", "--alert-after=4"], deps), 0);
    assert.equal(await reportUploadCleanup(["--apply"], deps), 0);
    health = await store.read();
    assert.equal(health.consecutiveFailures, 0);
    assert.equal(health.failedRuns, 3);
    assert.equal(health.failedObjects, 6);
    throwRun = true;
    assert.equal(await reportUploadCleanup(["--apply", "--alert-after=1"], deps), 1);
    assert.equal((await store.read()).consecutiveFailures, 1);
    assert.equal(logs.at(-1).data.aborted, true);
    assert.ok(!JSON.stringify(logs).includes("private-path"));
    assert.ok(!JSON.stringify(logs).includes("secret"));
    assert.ok(!JSON.stringify(logs).includes("entrant"));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("attention is immediate, bounded, private, and read-only by default", async () => {
  const health: CleanupHealth = { totalRuns: 0, failedRuns: 0, failedObjects: 0,
    consecutiveFailures: 0, lastFinishedAt: null, lastFailureAt: null };
  const logs: any[] = [];
  const calls: boolean[] = [];
  const records: unknown[] = [];
  let fences = 1000000;
  let counts = {};
  const deps = {
    read: async () => health,
    readFences: async () => fences,
    run: async (apply: boolean) => { calls.push(apply); return counts; },
    record: async (failed: boolean, objects: number) => { records.push([failed, objects]); return health; },
    log: (level: string, data: object, message: string) => logs.push({ level, data, message }),
  };
  assert.equal(await reportUploadCleanup(["--status"], deps), 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(records, []);
  assert.equal(logs.at(-1).data.attention.unresolvedDeletingFences, fences);
  assert.equal(await reportUploadCleanup([], deps), 1);
  assert.deepEqual(calls, [false]);
  assert.deepEqual(records, []);
  assert.equal(await reportUploadCleanup(["--apply"], deps), 1);
  assert.deepEqual(records, [[true, 0]]);
  fences = 0;
  for (const outcome of [{ changed_generation: 1 }, { failed: 1, storage_uncertain: 1 }]) {
    counts = { ...outcome, "https://private.invalid/signed?secret": 999 };
    assert.equal(await reportUploadCleanup([], deps), 1);
    const log = logs.at(-1);
    assert.equal(log.level, "warn");
    assert.equal(log.data.event, "entry_upload_cleanup_alert");
    assert.match(log.data.attention.guidance, /Never remove fences/);
    assert.ok(JSON.stringify(log).length < 2000);
    assert.ok(!JSON.stringify(log).includes("secret"));
  }
  counts = {};
  assert.equal(await reportUploadCleanup(["--status"], deps), 0);
  const before = calls.length;
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    fences = value;
    assert.equal(await reportUploadCleanup(["--apply"], deps), 1);
  }
  assert.equal(calls.length, before, "invalid reporting fails before cleanup");
});

test("invalid options and unavailable reporting fail safely without leaking errors", async () => {
  for (const arg of ["--alert-after=0", "--alert-after=-1", "--alert-after=1.5",
    "--alert-after=9007199254740992", "--alert-after=2secret", "--unknown"]) {
    assert.throws(() => parseCleanupOptions([arg]));
  }
  assert.throws(() => parseCleanupOptions(["--apply", "--status"]));
  assert.throws(() => parseCleanupOptions(["--apply", "--apply"]));
  const health: CleanupHealth = { totalRuns: 0, failedRuns: 0, failedObjects: 0,
    consecutiveFailures: 0, lastFinishedAt: null, lastFailureAt: null };
  let runs = 0;
  const logs: object[] = [];
  const deps = {
    readFences: async () => 0,
    read: async () => { throw new Error("secret database credentials"); },
    run: async () => { runs++; return { failed: 1 }; },
    record: async () => health,
    log: (_level: string, data: object, message: string) => { logs.push({ data, message }); },
  };
  assert.equal(await reportUploadCleanup(["--apply"], deps), 1);
  assert.equal(runs, 0);
  assert.equal(await reportUploadCleanup(["--apply"], {
    ...deps, read: async () => health,
    record: async () => { throw new Error("secret path"); },
  }), 1);
  assert.equal(runs, 1);
  assert.ok(!JSON.stringify(logs).includes("secret"));
});
