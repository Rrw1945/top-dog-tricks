import { createInsertSchema } from "drizzle-zod";
import {
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const submissionStatusEnum = pgEnum("submission_status", [
  "pending",
  "approved",
  "needs_edit",
  "rejected",
]);

export const submissionsTable = pgTable("submissions", {
  id: serial("id").primaryKey(),
  ownerName: text("owner_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  dogName: text("dog_name").notNull(),
  category: text("category", { enum: ["contest", "just_for_fun", "unclassified"] }).notNull().default("unclassified"),
  sourceCredit: text("source_credit"),
  sourceUrl: text("source_url"),
  soundtrack: text("soundtrack", { enum: ["replace_music", "voiceover_only"] }).notNull().default("replace_music"),
  breedBio: text("breed_bio"),
  trickName: text("trick_name").notNull(),
  trickDescription: text("trick_description").notNull(),
  videoObjectPath: text("video_object_path").notNull(),
  videoFileName: text("video_file_name").notNull(),
  videoContentType: text("video_content_type").notNull(),
  signatureObjectPath: text("signature_object_path").notNull(),
  driveReleaseFileId: text("drive_release_file_id"),
  driveReleaseUrl: text("drive_release_url"),
  airtableContestantId: text("airtable_contestant_id"),
  airtableSubmissionId: text("airtable_submission_id"),
  // Immutable receipt captured on new website inserts; NULL means historical/unknown.
  websiteOrigin: text("website_origin"),
  processingStatus: text("processing_status").notNull().default("queued"),
  trimStartSeconds: doublePrecision("trim_start_seconds"),
  trimEndSeconds: doublePrecision("trim_end_seconds"),
  aiAnalysisStatus: text("ai_analysis_status").notNull().default("not_analyzed"),
  aiAnalysisRunId: text("ai_analysis_run_id"),
  aiAnalysisStartedAt: timestamp("ai_analysis_started_at", {
    withTimezone: true,
  }),
  aiAnalysisHeartbeatAt: timestamp("ai_analysis_heartbeat_at", {
    withTimezone: true,
  }),
  aiAnalysisChunksCompleted: integer("ai_analysis_chunks_completed"),
  aiAnalysisChunksTotal: integer("ai_analysis_chunks_total"),
  aiTrimStartSeconds: doublePrecision("ai_trim_start_seconds"),
  aiTrimEndSeconds: doublePrecision("ai_trim_end_seconds"),
  aiDetectedAction: text("ai_detected_action"),
  aiPunchlines: text("ai_punchlines"),
  aiConfidence: doublePrecision("ai_confidence"),
  aiAnalysisError: text("ai_analysis_error"),
  processedVideoObjectPath: text("processed_video_object_path"),
  voiceoverObjectPath: text("voiceover_object_path"),
  processingError: text("processing_error"),
  status: submissionStatusEnum("status").notNull().default("pending"),
  punchline: text("punchline"),
  // First showcase eligibility; epoch marks pre-tracking publications with unknown dates.
  publishedAt: timestamp("published_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", {
    withTimezone: true,
  }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
  }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("submissions_review_status_id_idx").on(table.status, table.id.desc().nullsFirst()),
  // Keep separate trigram indexes: the review predicate is an OR across fields,
  // not a concatenation (which would change matching at field boundaries).
  index("submissions_review_dog_search_idx").using("gin", table.dogName.op("public.gin_trgm_ops")),
  index("submissions_review_owner_search_idx").using("gin", table.ownerName.op("public.gin_trgm_ops")),
  index("submissions_review_trick_search_idx").using("gin", table.trickName.op("public.gin_trgm_ops")),
]);

export const insertSubmissionSchema = createInsertSchema(submissionsTable).omit({
  id: true,
  websiteOrigin: true,
  category: true,
  sourceCredit: true,
  sourceUrl: true,
  soundtrack: true,
  status: true,
  punchline: true,
  publishedAt: true,
  submittedAt: true,
  updatedAt: true,
} as const);

export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissionsTable.$inferSelect;