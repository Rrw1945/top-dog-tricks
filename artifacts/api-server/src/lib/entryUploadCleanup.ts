import { db, entryUploadsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { hasUploadReference, trackedUploadPath } from "./entryUploadRegistry";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";

export const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export interface UploadMetadata { generation: string; updated: string }
export interface CleanupStorage {
  metadata(path: string): Promise<UploadMetadata | null>;
  deleteGeneration(path: string, generation: string): Promise<void>;
}

export const cleanupStorage: CleanupStorage = {
  async metadata(path) {
    try {
      const file = await new ObjectStorageService().getObjectEntityFile(path);
      const [meta] = await file.getMetadata();
      if (!meta.generation || !meta.updated) throw new Error("Incomplete upload metadata");
      return { generation: String(meta.generation), updated: meta.updated };
    } catch (error) {
      if (error instanceof ObjectNotFoundError || (error as { code?: number }).code === 404) return null;
      throw error;
    }
  },
  async deleteGeneration(path, generation) {
    try {
      const file = await new ObjectStorageService().getObjectEntityFile(path);
      // Keep the string generation intact (GCS generations can exceed safe integers).
      await file.bucket.file(file.name, { generation }).delete({ ifGenerationMatch: generation });
    } catch (error) {
      if (error instanceof ObjectNotFoundError || (error as { code?: number }).code === 404) return;
      throw error;
    }
  },
};

export function completionExpiry(now: Date, metadata: UploadMetadata): Date {
  const updated = Date.parse(metadata.updated);
  if (!Number.isFinite(updated) || updated > now.getTime() ||
      !/^[1-9][0-9]*$/.test(metadata.generation)) throw new Error("Invalid upload metadata");
  return new Date(Math.max(now.getTime(), updated) + UPLOAD_RETENTION_MS);
}

export async function cleanOneUpload(path: string, apply: boolean, storage: CleanupStorage) {
  if (!trackedUploadPath.test(path)) return "excluded";
  const claim = await db.transaction(async tx => {
    const [row] = await tx.select().from(entryUploadsTable)
      .where(eq(entryUploadsTable.objectPath, path)).for("update", { skipLocked: true });
    if (!row || row.state === "deleted") return { result: "excluded" };
    const nowResult = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    const now = new Date(nowResult.rows[0].now);
    if (apply) await tx.update(entryUploadsTable).set({ checkedAt: now }).where(eq(entryUploadsTable.objectPath, path));
    if (await hasUploadReference(tx, path)) return { result: "referenced" };
    const meta = await storage.metadata(path);
    if (!meta) {
      if (apply && row.state === "deleting") await tx.update(entryUploadsTable)
        .set({ state: "deleted" }).where(eq(entryUploadsTable.objectPath, path));
      return { result: "missing" };
    }
    // Validate even already-observed metadata; fail closed on corrupt timestamps.
    completionExpiry(now, meta);
    if (row.state === "deleting") {
      // A deleting tombstone is never made attachable again, even after errors.
      // A replacement is not the generation this claim authorized us to delete.
      if (row.generation !== meta.generation) return { result: "changed_generation" };
      return { generation: row.generation };
    }
    if (row.generation !== meta.generation || !row.eligibleAt ||
        Date.parse(meta.updated) > row.eligibleAt.getTime() - UPLOAD_RETENTION_MS) {
      if (apply) await tx.update(entryUploadsTable).set({
        state: "completed", generation: meta.generation, eligibleAt: completionExpiry(now, meta),
      }).where(eq(entryUploadsTable.objectPath, path));
      return { result: "observed" };
    }
    if (row.eligibleAt > now) return { result: "young" };
    if (!apply) return { result: "eligible" };
    await tx.update(entryUploadsTable).set({ state: "deleting" }).where(eq(entryUploadsTable.objectPath, path));
    return { generation: meta.generation };
  });
  if (claim.result) return claim.result;
  if (!apply) return "eligible";
  // The committed tombstone fences attachment even if this process dies here.
  // Database triggers reject legacy/script writes too.
  await storage.deleteGeneration(path, claim.generation!);
  await db.update(entryUploadsTable).set({ state: "deleted" }).where(eq(entryUploadsTable.objectPath, path));
  return "deleted";
}

export async function runUploadCleanup(apply = false, storage = cleanupStorage, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid cleanup limit");
  // Fail closed if the migration's write fences have not been installed.
  const fences = await db.execute(sql`select tgname from pg_trigger
    where tgname in ('submission_upload_fence', 'admin_media_upload_fence')
      and tgenabled = 'O' and not tgisinternal`);
  if (fences.rows.length !== 2) throw new Error("Install upload cleanup migration before running cleanup");
  const rows = await db.select().from(entryUploadsTable)
    .where(sql`${entryUploadsTable.state} <> 'deleted'`)
    .orderBy(entryUploadsTable.checkedAt, entryUploadsTable.objectPath).limit(limit);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    try {
      const result = await cleanOneUpload(row.objectPath, apply, storage);
      counts[result] = (counts[result] ?? 0) + 1;
    } catch {
      counts.failed = (counts.failed ?? 0) + 1;
      // Rotate failed rows too so one unavailable object cannot starve the queue.
      if (apply) await db.update(entryUploadsTable).set({ checkedAt: sql`clock_timestamp()` })
        .where(eq(entryUploadsTable.objectPath, row.objectPath));
    }
  }
  return counts;
}
