import { createInsertSchema } from "drizzle-zod";
import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { submissionsTable } from "./submissions";

export const videoLikesTable = pgTable(
  "video_likes",
  {
    id: serial("id").primaryKey(),
    submissionId: integer("submission_id")
      .notNull()
      .references(() => submissionsTable.id, { onDelete: "cascade" }),
    browserHash: text("browser_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("video_likes_submission_browser_idx").on(table.submissionId, table.browserHash)],
);

export const subscribersTable = pgTable(
  "subscribers",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    verificationTokenHash: text("verification_token_hash"),
    replacementVerificationAttemptId: text("replacement_verification_attempt_id"),
    unsubscribeTokenHash: text("unsubscribe_token_hash").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    welcomeEmailStatus: text("welcome_email_status"),
    welcomeEmailClaimedAt: timestamp("welcome_email_claimed_at", { withTimezone: true }),
    welcomeEmailDeliveredAt: timestamp("welcome_email_delivered_at", { withTimezone: true }),
    welcomeEmailFailedAt: timestamp("welcome_email_failed_at", { withTimezone: true }),
    welcomeEmailLastError: text("welcome_email_last_error"),
    welcomeEmailAttemptCount: integer("welcome_email_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("subscribers_email_idx").on(sql`lower(trim(${table.email}))`),
  ],
);

export const spotlightNotificationsTable = pgTable(
  "spotlight_notifications",
  {
    id: serial("id").primaryKey(),
    submissionId: integer("submission_id")
      .notNull()
      .references(() => submissionsTable.id, { onDelete: "cascade" }),
    subscriberId: integer("subscriber_id")
      .notNull()
      .references(() => subscribersTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("delivered"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    attemptCount: integer("attempt_count").notNull().default(1),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("spotlight_notifications_submission_subscriber_idx").on(
      table.submissionId,
      table.subscriberId,
    ),
  ],
);

export const insertVideoLikeSchema = createInsertSchema(videoLikesTable).omit({
  id: true,
  createdAt: true,
} as const);
export const insertSubscriberSchema = createInsertSchema(subscribersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
} as const);
export type VideoLike = typeof videoLikesTable.$inferSelect;
export type Subscriber = typeof subscribersTable.$inferSelect;
export type SpotlightNotification =
  typeof spotlightNotificationsTable.$inferSelect;
export type InsertVideoLike = z.infer<typeof insertVideoLikeSchema>;
export type InsertSubscriber = z.infer<typeof insertSubscriberSchema>;