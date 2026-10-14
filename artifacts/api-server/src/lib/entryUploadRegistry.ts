import { db, entryUploadsTable, submissionsTable, protectedMediaTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { InvalidUploadError } from "./uploadValidation";
import { randomUUID } from "node:crypto";

export type UploadTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const trackedUploadPath = /^\/objects\/(?:uploads|accepted)\/[a-f0-9-]{36}$/;

// Commit before copying, separately from the submission transaction: a rollback
// must not erase the only record of an orphan. Historical accepted files are
// deliberately never backfilled.
export async function reserveEntryCopies(): Promise<[string, string]> {
  const paths: [string, string] = [
    `/objects/accepted/${randomUUID()}`, `/objects/accepted/${randomUUID()}`,
  ];
  await db.insert(entryUploadsTable).values(paths.map(objectPath => ({ objectPath })));
  return paths;
}

export async function registerEntryUpload(objectPath: string): Promise<void> {
  await db.insert(entryUploadsTable).values({ objectPath });
}

// The transaction owns row locks until validation, copies AND insertion finish.
// A lost database connection aborts the transaction; it cannot commit an entry.
export async function withEntryUploads<T>(
  paths: string[], work: (tx: UploadTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async tx => {
    for (const path of [...new Set(paths)].sort()) {
      const [row] = await tx.select().from(entryUploadsTable)
        .where(eq(entryUploadsTable.objectPath, path)).for("update");
      if (row && (row.state === "deleting" || row.state === "deleted")) {
        throw new InvalidUploadError("These uploads have expired. Please upload your files again.");
      }
    }
    return work(tx);
  });
}

export async function hasUploadReference(tx: UploadTransaction, path: string): Promise<boolean> {
  // Conservatively match the opaque ID, including full serving URLs and aliases.
  const id = path.split("/").at(-1)!;
  const [submission] = await tx.select({ id: submissionsTable.id }).from(submissionsTable)
    .where(sql`${submissionsTable.videoObjectPath} like ${`%${id}%`}
      or ${submissionsTable.signatureObjectPath} like ${`%${id}%`}
      or ${submissionsTable.processedVideoObjectPath} like ${`%${id}%`}
      or ${submissionsTable.voiceoverObjectPath} like ${`%${id}%`}`).limit(1);
  const [media] = await tx.select().from(protectedMediaTable)
    .where(sql`${protectedMediaTable.objectPath} like ${`%${id}%`}`).limit(1);
  return Boolean(submission || media);
}

export async function protectAdminMedia(path: string): Promise<void> {
  await withEntryUploads([path], async tx => {
    await tx.insert(protectedMediaTable).values({ objectPath: path }).onConflictDoNothing();
  });
}

