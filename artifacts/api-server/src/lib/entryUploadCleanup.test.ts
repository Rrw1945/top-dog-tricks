import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, entryUploadsTable, protectedMediaTable, submissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { cleanOneUpload, completionExpiry, UPLOAD_RETENTION_MS, type CleanupStorage } from "./entryUploadCleanup";
import { withEntryUploads, protectAdminMedia, reserveEntryCopies } from "./entryUploadRegistry";

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
