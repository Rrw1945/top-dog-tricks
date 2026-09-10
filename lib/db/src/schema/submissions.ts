import { createInsertSchema } from "drizzle-zod";
import {
  doublePrecision,
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
  submittedAt: timestamp("submitted_at", {
    withTimezone: true,
  }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
  }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSubmissionSchema = createInsertSchema(submissionsTable).omit({
  id: true,
  status: true,
  punchline: true,
  submittedAt: true,
  updatedAt: true,
} as const);

export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissionsTable.$inferSelect;