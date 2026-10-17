import { pgTable, text, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

// Only sessions issued after tracking was installed are eligible for cleanup.
export const entryUploadsTable = pgTable("entry_uploads", {
  objectPath: text("object_path").primaryKey(),
  state: text("state").notNull().default("issued"),
  generation: text("generation"),
  eligibleAt: timestamp("eligible_at", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("entry_uploads_checked_idx").on(table.checkedAt),
  index("entry_uploads_reference_id_idx").on(sql`split_part(${table.objectPath}, '/', 4)`),
  index("entry_uploads_legacy_reference_idx").on(table.objectPath)
    .where(sql`split_part(${table.objectPath}, '/', 4) !~ '^[a-f0-9-]{36}$'`),
]);

// Derived by database triggers, never by application writers. No status filter.
export const entryUploadReferencesTable = pgTable("entry_upload_references", {
  token: text("token").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceKey: text("source_key").notNull(),
}, table => [
  primaryKey({ columns: [table.token, table.sourceKind, table.sourceKey] }),
  index("entry_upload_references_source_idx").on(table.sourceKind, table.sourceKey),
]);

// Reservations for admin assets not represented by a submission.
export const protectedMediaTable = pgTable("protected_media", {
  objectPath: text("object_path").primaryKey(),
});

export const insertEntryUploadSchema = createInsertSchema(entryUploadsTable);
export type EntryUpload = typeof entryUploadsTable.$inferSelect;
export type InsertEntryUpload = typeof entryUploadsTable.$inferInsert;
