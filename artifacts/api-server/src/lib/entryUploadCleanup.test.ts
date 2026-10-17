import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, pool, entryUploadsTable, protectedMediaTable, submissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { cleanOneUpload, runUploadCleanup, readUploadCleanupFences, completionExpiry, UPLOAD_RETENTION_MS, type CleanupStorage } from "./entryUploadCleanup";
import { withEntryUploads, protectAdminMedia, reserveEntryCopies } from "./entryUploadRegistry";

// Private tables ensure the batch query cannot select or update real uploads.
// A second connection holds actual PostgreSQL row locks, not mocked lock results.
async function withBatchFixture(t: TestContext, work: (fixture: {
  paths: string[];
  storage: CleanupStorage;
  metadataCalls: string[];
  deleteCalls: string[];
  failMetadata: Set<string>;
  failDelete: Set<string>;
  read: () => Promise<(typeof entryUploadsTable.$inferSelect)[]>;
  lock: (path: string, work: () => Promise<void>) => Promise<void>;
}) => Promise<void>) {
  const schema = `cleanup_batch_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  const locker = await pool.connect();
  const isolated = drizzle(client);
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await locker.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE entry_uploads (
      object_path text PRIMARY KEY, state text NOT NULL,
      generation text, eligible_at timestamptz, checked_at timestamptz NOT NULL
    )`);
    // Every reference lookup is restricted to synthetic, unreferenced rows.
    await client.query(`CREATE FUNCTION entry_upload_has_reference(text)
      RETURNS boolean LANGUAGE sql AS 'SELECT false'`);
    for (const method of ["select", "update", "execute", "transaction"] as const) {
      t.mock.method(db, method, isolated[method].bind(isolated));
    }
    const paths = Array.from({ length: 5 }, (_, i) =>
      `/objects/uploads/00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`);
    await isolated.insert(entryUploadsTable).values(paths.map((objectPath, i) => ({
      objectPath, state: i === 4 ? "deleted" : "completed", generation: "123",
      eligibleAt: new Date("2001-01-01"),
      // Equal check times exercise the object-path tie breaker as well.
      checkedAt: new Date("2000-01-01"),
    })));
    const metadataCalls: string[] = [];
    const deleteCalls: string[] = [];
    const failMetadata = new Set<string>();
    const failDelete = new Set<string>();
    const storage: CleanupStorage = {
      async metadata(path) {
        assert.ok(paths.includes(path), "storage must only see fixture paths");
        metadataCalls.push(path);
        if (failMetadata.has(path)) throw new Error("synthetic metadata failure");
        return { generation: "123", updated: "2000-01-01T00:00:00.000Z" };
      },
      async deleteGeneration(path, generation) {
        assert.ok(paths.includes(path), "storage must only see fixture paths");
        assert.equal(generation, "123");
        deleteCalls.push(path);
        if (failDelete.has(path)) throw new Error("synthetic delete failure");
      },
    };
    await work({
      paths, storage, metadataCalls, deleteCalls, failMetadata, failDelete,
      read: () => isolated.select().from(entryUploadsTable).orderBy(entryUploadsTable.objectPath),
      async lock(path, work) {
        await locker.query("BEGIN");
        try {
          await locker.query("SELECT * FROM entry_uploads WHERE object_path = $1 FOR UPDATE", [path]);
          // A regression removing SKIP LOCKED must fail promptly, not hang.
          await client.query("SET statement_timeout = '2s'");
          await work();
        } finally {
          await locker.query("ROLLBACK");
          await client.query("RESET statement_timeout");
        }
      },
    });
  } finally {
    t.mock.restoreAll();
    try {
      await client.query("RESET search_path");
      await locker.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      // Discard fixture connections even if teardown fails; never return a
      // connection with an isolated search_path to the shared pool.
      client.release(true);
      locker.release(true);
    }
  }
}

test("fence reporting includes out-of-batch fences without probing or mutating storage", async t => {
  await withBatchFixture(t, async ({ paths, storage, metadataCalls, deleteCalls, read }) => {
    await db.update(entryUploadsTable).set({ state: "deleting" })
      .where(eq(entryUploadsTable.objectPath, paths[3]));
    const before = await read();
    assert.equal(await readUploadCleanupFences(), 1);
    assert.deepEqual(metadataCalls, []);
    assert.deepEqual(await runUploadCleanup(false, storage, 1), { eligible: 1 });
    assert.equal(await readUploadCleanupFences(), 1);
    assert.deepEqual(await read(), before);
    assert.deepEqual(deleteCalls, []);
  });
});

test("changed generations and uncertain metadata retain permanent fences", async t => {
  await withBatchFixture(t, async ({ paths, storage, failMetadata, deleteCalls, read }) => {
    await db.update(entryUploadsTable).set({ state: "deleting", generation: "122" })
      .where(eq(entryUploadsTable.objectPath, paths[0]));
    const before = await read();
    assert.deepEqual(await runUploadCleanup(false, storage, 1), { changed_generation: 1 });
    assert.deepEqual(await read(), before);
    assert.deepEqual(await runUploadCleanup(true, storage, 1), { changed_generation: 1 });
    const [changed] = await read();
    assert.equal(changed.state, "deleting");
    assert.equal(changed.generation, "122");
    await db.update(entryUploadsTable).set({ state: "deleting" })
      .where(eq(entryUploadsTable.objectPath, paths[1]));
    failMetadata.add(paths[1]);
    assert.deepEqual(await runUploadCleanup(true, storage, 1), { failed: 1, storage_uncertain: 1 });
    assert.equal(await readUploadCleanupFences(), 2);
    assert.deepEqual(deleteCalls, []);
  });
});

test("batch cleanup honors its limit, excludes deleted rows, and progresses on later passes", async t => {
  await withBatchFixture(t, async ({ paths, storage, metadataCalls, deleteCalls, read }) => {
    const before = await read();
    assert.deepEqual(await runUploadCleanup(false, storage, 2), { eligible: 2 });
    assert.deepEqual(metadataCalls.splice(0), paths.slice(0, 2));
    assert.deepEqual(deleteCalls, []);
    assert.deepEqual(await read(), before, "dry runs must not rotate or mutate rows");

    assert.deepEqual(await runUploadCleanup(true, storage, 2), { deleted: 2 });
    assert.deepEqual(metadataCalls.splice(0), paths.slice(0, 2));
    assert.deepEqual((await read()).slice(2), before.slice(2), "limit leaves later rows untouched");
    assert.deepEqual(await runUploadCleanup(true, storage, 2), { deleted: 2 });
    assert.deepEqual(metadataCalls.splice(0), paths.slice(2, 4));
    assert.deepEqual(await runUploadCleanup(true, storage, 2), {});
    assert.deepEqual(deleteCalls, paths.slice(0, 4));
    assert.deepEqual(metadataCalls, []);
  });
});

test("batch cleanup rotates metadata and delete failures behind unchecked uploads", async t => {
  await withBatchFixture(t, async ({ paths, storage, metadataCalls, deleteCalls, failMetadata, failDelete, read }) => {
    failMetadata.add(paths[0]);
    failDelete.add(paths[1]);
    const before = await read();
    assert.deepEqual(await runUploadCleanup(true, storage, 3), { failed: 2, storage_uncertain: 1, deleted: 1 });
    assert.deepEqual(metadataCalls.splice(0), paths.slice(0, 3));
    const after = await read();
    assert.equal(after[0].state, "completed", "metadata failure rolls back its claim");
    assert.equal(after[1].state, "deleting", "delete failure retains its attachment fence");
    for (const i of [0, 1, 2]) assert.ok(after[i].checkedAt > before[i].checkedAt);
    assert.deepEqual(after.slice(3), before.slice(3));
    assert.deepEqual(await runUploadCleanup(true, storage, 1), { deleted: 1 });
    assert.deepEqual(metadataCalls.splice(0), [paths[3]], "unchecked row wins over failed rows");
    failMetadata.clear();
    failDelete.clear();
    assert.deepEqual(await runUploadCleanup(true, storage, 2), { deleted: 2 });
    assert.deepEqual(metadataCalls.splice(0), paths.slice(0, 2));
    assert.deepEqual(deleteCalls, [paths[1], paths[2], paths[3], paths[0], paths[1]]);
    assert.deepEqual(await runUploadCleanup(true, storage, 2), {});
  });
});

test("batch cleanup skips a locked row, processes its neighbor, and returns after release", async t => {
  await withBatchFixture(t, async ({ paths, storage, metadataCalls, deleteCalls, read, lock }) => {
    const before = await read();
    await lock(paths[0], async () => {
      assert.deepEqual(await runUploadCleanup(true, storage, 2), { excluded: 1, deleted: 1 });
      assert.deepEqual(metadataCalls.splice(0), [paths[1]]);
      assert.deepEqual(deleteCalls, [paths[1]]);
      assert.deepEqual((await read())[0], before[0], "locked row must remain unchanged");
    });
    assert.deepEqual(await runUploadCleanup(true, storage, 2), { deleted: 2 });
    assert.deepEqual(metadataCalls.splice(0), [paths[0], paths[2]]);
    assert.deepEqual(await runUploadCleanup(true, storage, 2), { deleted: 1 });
    assert.deepEqual(metadataCalls.splice(0), [paths[3]]);
    assert.deepEqual(deleteCalls, [paths[1], paths[0], paths[2], paths[3]]);
  });
});

test("batch cleanup rejects invalid limits before querying the database", async t => {
  const query = t.mock.method(db, "execute", () => { throw new Error("unexpected database access"); });
  for (const limit of [0, -1, 1.5, 1001, NaN, Infinity]) {
    await assert.rejects(runUploadCleanup(true, {} as CleanupStorage, limit), /Invalid cleanup limit/);
  }
  assert.equal(query.mock.callCount(), 0);
});

test("cleanup uses completed-object retention, fences attachment, and protects all references", async () => {
  const paths: string[] = [];
  const deleted: string[] = [];
  const metadata = new Map<string, { generation: string; updated: string }>();
  const storage: CleanupStorage = {
    async metadata(path) { return metadata.get(path) ?? null; },
    async deleteGeneration(path, generation) {
      assert.equal(generation, metadata.get(path)?.generation);
      deleted.push(path); metadata.delete(path);
    },
  };
  const make = async (state = "completed") => {
    const objectPath = `/objects/uploads/${randomUUID()}`; paths.push(objectPath);
    await db.insert(entryUploadsTable).values({
      objectPath, state, generation: "123", eligibleAt: new Date(Date.now() - 1000),
    });
    metadata.set(objectPath, { generation: "123", updated: new Date(Date.now() - UPLOAD_RETENTION_MS - 10000).toISOString() });
    return objectPath;
  };
  try {
    const copies = await reserveEntryCopies();
    paths.push(...copies);
    // A failed copy/insertion rolls back its transaction, not its reservations.
    await assert.rejects(withEntryUploads(copies, async () => {
      metadata.set(copies[0], { generation: "123", updated: new Date().toISOString() });
      assert.equal(await cleanOneUpload(copies[0], true, storage), "excluded");
      throw new Error("insertion failed");
    }), /insertion failed/);
    const [reserved] = await db.select().from(entryUploadsTable).where(eq(entryUploadsTable.objectPath, copies[0]));
    assert.equal(reserved.state, "issued");
    assert.equal(await cleanOneUpload(copies[0], false, storage), "observed");
    const [unchanged] = await db.select().from(entryUploadsTable).where(eq(entryUploadsTable.objectPath, copies[0]));
    assert.deepEqual(unchanged, reserved);
    assert.equal(await cleanOneUpload(copies[0], true, storage), "observed");
    assert.equal(await cleanOneUpload(copies[0], true, storage), "young");
    assert.equal(await cleanOneUpload(copies[1], true, storage), "missing");
    metadata.set(copies[0], { generation: "123", updated: new Date(Date.now() - UPLOAD_RETENTION_MS - 10000).toISOString() });
    await db.update(entryUploadsTable).set({ eligibleAt: new Date(Date.now() - 1000) }).where(eq(entryUploadsTable.objectPath, copies[0]));
    assert.equal(await cleanOneUpload(copies[0], false, storage), "eligible");
    // After the cleanup fence commits, neither submission nor admin attachment
    // may win the race, even before the actual storage delete completes.
    assert.equal(await cleanOneUpload(copies[0], true, {
      ...storage,
      async deleteGeneration(path, generation) {
        await assert.rejects(protectAdminMedia(path), /expired/);
        await assert.rejects(withEntryUploads([path], async () => {}), /expired/);
        await storage.deleteGeneration(path, generation);
      },
    }), "deleted");

    // Each media column independently protects a tracked preserved copy,
    // including published output and signatures on rejected entries.
    for (const column of ["videoObjectPath", "signatureObjectPath", "processedVideoObjectPath", "voiceoverObjectPath"] as const) {
      const pair = await reserveEntryCopies();
      paths.push(...pair);
      const path = pair[0];
      metadata.set(path, { generation: "123", updated: new Date(Date.now() - UPLOAD_RETENTION_MS - 10000).toISOString() });
      await db.update(entryUploadsTable).set({ state: "completed", generation: "123", eligibleAt: new Date(Date.now() - 1000) }).where(eq(entryUploadsTable.objectPath, path));
      const [entry] = await db.insert(submissionsTable).values({
        ownerName: "Cleanup fixture", email: "fixture@example.invalid", phone: "", dogName: "Fixture",
        trickName: "Fixture", trickDescription: "Fixture", status: "rejected",
        videoObjectPath: "/untracked/video", signatureObjectPath: "/untracked/signature",
        videoFileName: "fixture.mp4", videoContentType: "video/mp4",
        [column]: `https://example.invalid/api/storage${path}`,
      }).returning();
      try {
        assert.equal(await cleanOneUpload(path, true, storage), "referenced");
        assert.ok(!deleted.includes(path));
      } finally { await db.delete(submissionsTable).where(eq(submissionsTable.id, entry.id)); }
    }
    const abandoned = await make();
    assert.equal(await cleanOneUpload(abandoned, false, storage), "eligible");
    assert.ok(!deleted.includes(abandoned));
    assert.equal(await cleanOneUpload(abandoned, true, storage), "deleted");
    await assert.rejects(withEntryUploads([abandoned], async () => {}), /expired/);
    await assert.rejects(db.insert(protectedMediaTable).values({ objectPath: abandoned }),
      (error: any) => /expired/.test(error.cause?.message));

    const recent = await make("issued");
    await db.update(entryUploadsTable).set({ generation: null, eligibleAt: null }).where(eq(entryUploadsTable.objectPath, recent));
    assert.equal(await cleanOneUpload(recent, true, storage), "observed");
    assert.equal(await cleanOneUpload(recent, true, storage), "young");
    const active = await make();
    metadata.delete(active);
    assert.equal(await cleanOneUpload(active, true, storage), "missing");

    const referenced = await make();
    await protectAdminMedia(referenced);
    assert.equal(await cleanOneUpload(referenced, true, storage), "referenced");
    for (const status of ["pending", "approved", "needs_edit", "rejected"] as const) {
      const path = await make();
      const [entry] = await db.insert(submissionsTable).values({
        ownerName: "Cleanup fixture", email: "fixture@example.invalid", phone: "", dogName: "Fixture",
        trickName: "Fixture", trickDescription: "Fixture", status,
        videoObjectPath: `https://example.invalid/api/storage${path}`,
        signatureObjectPath: path, videoFileName: "fixture.mp4", videoContentType: "video/mp4",
        submittedAt: new Date("2026-01-01"),
      }).returning();
      try {
        assert.equal(await cleanOneUpload(path, true, storage), "referenced");
      } finally { await db.delete(submissionsTable).where(eq(submissionsTable.id, entry.id)); }
    }
    const locked = await make();
    await withEntryUploads([locked], async () => {
      assert.equal(await cleanOneUpload(locked, true, storage), "excluded");
    });
    const replaced = await make();
    metadata.set(replaced, { generation: "124", updated: new Date().toISOString() });
    assert.equal(await cleanOneUpload(replaced, true, storage), "observed");
    const failed = await make();
    await assert.rejects(cleanOneUpload(failed, true, { ...storage, async deleteGeneration() { throw new Error("uncertain"); } }));
    await assert.rejects(withEntryUploads([failed], async () => {}), /expired/);
    assert.equal(await cleanOneUpload(failed, true, storage), "deleted");
    assert.equal(await cleanOneUpload(`/objects/accepted/${randomUUID()}`, true, storage), "excluded");
    assert.equal(await cleanOneUpload(`/objects/uploads/${randomUUID()}`, true, storage), "excluded");
    const invalid = await make();
    metadata.set(invalid, { generation: "123", updated: "invalid" });
    await assert.rejects(cleanOneUpload(invalid, true, storage), /metadata/);
    const lookupFailure = await make();
    await assert.rejects(cleanOneUpload(lookupFailure, true, { ...storage, async metadata() { throw new Error("unavailable"); } }));
    assert.ok(!deleted.includes(lookupFailure));
    assert.equal(completionExpiry(new Date(0), { generation: "1", updated: new Date(0).toISOString() }).getTime(), UPLOAD_RETENTION_MS);
  } finally {
    for (const path of paths) {
      await db.delete(protectedMediaTable).where(eq(protectedMediaTable.objectPath, path));
      await db.delete(entryUploadsTable).where(eq(entryUploadsTable.objectPath, path));
    }
  }
});
