import { integer, pgTable, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const uploadCleanupHealthTable = pgTable("entry_upload_cleanup_health", {
  id: integer("id").primaryKey().default(1),
  totalRuns: integer("total_runs").notNull().default(0),
  failedRuns: integer("failed_runs").notNull().default(0),
  failedObjects: integer("failed_objects").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
}, table => [check("entry_upload_cleanup_health_singleton", sql`${table.id} = 1`)]);
export const insertUploadCleanupHealthSchema = createInsertSchema(uploadCleanupHealthTable);
export type UploadCleanupHealth = typeof uploadCleanupHealthTable.$inferSelect;
