import { createInsertSchema } from "drizzle-zod";
import {
  index,
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
    replacementVerificationRetryAt: timestamp("replacement_verification_retry_at", {
      withTimezone: true,
    }),
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
    index("subscribers_welcome_recovery_idx")
      .on(table.welcomeEmailClaimedAt, table.id)
      .where(
        sql`${table.verifiedAt} IS NOT NULL
          AND ${table.unsubscribedAt} IS NULL
          AND ${table.welcomeEmailStatus} IN ('failed', 'claimed')`,
      ),
    index("subscribers_welcome_failed_backlog_idx")
      .on(table.id)
      .where(
        sql`${table.verifiedAt} IS NOT NULL
          AND ${table.unsubscribedAt} IS NULL
          AND ${table.welcomeEmailStatus} = 'failed'`,
      ),
    index("subscribers_welcome_expired_backlog_idx")
      .on(table.welcomeEmailClaimedAt, table.welcomeEmailAttemptCount)
      .where(
        sql`${table.verifiedAt} IS NOT NULL
          AND ${table.unsubscribedAt} IS NULL
          AND ${table.welcomeEmailStatus} = 'claimed'`,
      ),
    index("subscribers_welcome_admin_idx")
      .on(table.id)
      .where(
        sql`${table.welcomeEmailStatus} IN ('claimed', 'failed', 'permanently_failed')`,
      ),
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

export const analyticsCoverageAlertsTable = pgTable(
  "analytics_coverage_alerts",
  {
    id: serial("id").primaryKey(),
    alertKey: text("alert_key").notNull(),
    kind: text("kind").notNull(),
    cohortDates: text("cohort_dates").array().notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // A started but unsent delivery has an uncertain outcome: never auto-reclaim.
    deliveryStartedAt: timestamp("delivery_started_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("analytics_coverage_alerts_key_idx").on(table.alertKey),
    index("analytics_coverage_alerts_pending_idx").on(
      table.sentAt,
      table.claimedAt,
      table.id,
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
export type AnalyticsCoverageAlert =
  typeof analyticsCoverageAlertsTable.$inferSelect;
export type InsertVideoLike = z.infer<typeof insertVideoLikeSchema>;
export type InsertSubscriber = z.infer<typeof insertSubscriberSchema>;