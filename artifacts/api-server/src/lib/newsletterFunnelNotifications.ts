import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import {
  analyticsCoverageAlertsTable,
  db,
} from "@workspace/db";
import {
  sendSlackAnalyticsCoverageRegression,
  type AnalyticsCoverageRegressionNotification,
} from "./integrations";
import { sendAnalyticsCoverageRegressionEmail } from "./subscriberEmail";
import type { NewsletterFunnelReport } from "./newsletterFunnelAnalytics";

const CLAIM_LEASE_MS = 10 * 60 * 1_000;

type CoverageRegression = AnalyticsCoverageRegressionNotification;

export type NewsletterFunnelNotificationDependencies = {
  claimAlert?: (alert: CoverageRegression) => Promise<number | null>;
  startAlertDelivery?: (id: number) => Promise<boolean>;
  markAlertSent?: (id: number) => Promise<void>;
  releaseAlert?: (id: number) => Promise<void>;
  sendAlert?: (
    alert: CoverageRegression,
    idempotencyKey: string,
  ) => Promise<void>;
  sendFallbackAlert?: (
    alert: CoverageRegression,
    idempotencyKey: string,
  ) => Promise<void>;
  onProviderFailure?: (
    channel: "Slack" | "Resend",
    error: unknown,
  ) => void;
};

function coverageRegressionAlert(
  report: NewsletterFunnelReport,
): CoverageRegression | null {
  const regression = report.coverage.alerts.find(
    (alert) => alert.kind === "coverage_regression",
  );
  if (!regression) return null;

  const cohorts = regression.cohorts
    .map((cohort) => report.coverage.cohorts.find((row) => row.cohort === cohort))
    .filter((row): row is NewsletterFunnelReport["coverage"]["cohorts"][number] =>
      row !== undefined,
    )
    .sort((left, right) => left.cohort.localeCompare(right.cohort))
    .map(({ cohort, requests }) => ({ cohort, requests }));

  return cohorts.length > 0
    ? { cohorts }
    : null;
}

function alertKey(alert: CoverageRegression): string {
  return JSON.stringify({
    kind: "coverage_regression",
    cohorts: alert.cohorts,
  });
}

function deliveryId(alert: CoverageRegression): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(alertKey(alert))
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function claimAlert(alert: CoverageRegression): Promise<number | null> {
  const inserted = await db
    .insert(analyticsCoverageAlertsTable)
    .values({
      alertKey: alertKey(alert),
      kind: "coverage_regression",
      cohortDates: alert.cohorts.map(({ cohort }) => cohort),
    })
    .onConflictDoNothing({
      target: analyticsCoverageAlertsTable.alertKey,
    })
    .returning({ id: analyticsCoverageAlertsTable.id });
  if (inserted[0]) return inserted[0].id;

  const reclaimed = await db
    .update(analyticsCoverageAlertsTable)
    .set({ claimedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(analyticsCoverageAlertsTable.alertKey, alertKey(alert)),
        isNull(analyticsCoverageAlertsTable.sentAt),
        isNull(analyticsCoverageAlertsTable.deliveryStartedAt),
        lt(
          analyticsCoverageAlertsTable.claimedAt,
          sql`CURRENT_TIMESTAMP - (${CLAIM_LEASE_MS} * interval '1 millisecond')`,
        ),
      ),
    )
    .returning({ id: analyticsCoverageAlertsTable.id });
  return reclaimed[0]?.id ?? null;
}

async function startAlertDelivery(id: number): Promise<boolean> {
  // Commit before contacting either provider. A crash or failed sent-status write
  // leaves a durable hold, independent of process memory or provider dedup TTLs.
  const started = await db.update(analyticsCoverageAlertsTable)
    .set({ deliveryStartedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(
      eq(analyticsCoverageAlertsTable.id, id),
      isNull(analyticsCoverageAlertsTable.sentAt),
      isNull(analyticsCoverageAlertsTable.deliveryStartedAt),
    ))
    .returning({ id: analyticsCoverageAlertsTable.id });
  return started.length > 0;
}

async function markAlertSent(id: number): Promise<void> {
  await db
    .update(analyticsCoverageAlertsTable)
    .set({ sentAt: new Date() })
    .where(eq(analyticsCoverageAlertsTable.id, id));
}

async function releaseAlert(id: number): Promise<void> {
  await db
    .delete(analyticsCoverageAlertsTable)
    .where(
      and(
        eq(analyticsCoverageAlertsTable.id, id),
        isNull(analyticsCoverageAlertsTable.sentAt),
      ),
    );
}

export function getCoverageRegressionAlertKey(
  alert: CoverageRegression,
): string {
  return alertKey(alert);
}

export async function notifyNewsletterCoverageRegressions(
  report: NewsletterFunnelReport,
  dependencies: NewsletterFunnelNotificationDependencies = {},
): Promise<boolean> {
  const alert = coverageRegressionAlert(report);
  if (!alert) return false;

  const claimedId = await (dependencies.claimAlert ?? claimAlert)(alert);
  if (claimedId === null) return false;

  // Do not release on a failed start write: it may have committed. Only the
  // successful CAS owner may send or release this row.
  if (!await (dependencies.startAlertDelivery ?? startAlertDelivery)(claimedId)) {
    return false;
  }

  const idempotencyKey = deliveryId(alert);
  let alertDelivered = false;
  try {
    try {
      await (dependencies.sendAlert ?? sendSlackAnalyticsCoverageRegression)(
        alert,
        idempotencyKey,
      );
      alertDelivered = true;
    } catch (slackError) {
      try {
        dependencies.onProviderFailure?.("Slack", slackError);
      } catch {
        // Provider error reporting must not block the fallback.
      }
      try {
        await (
          dependencies.sendFallbackAlert ??
          sendAnalyticsCoverageRegressionEmail
        )(alert, idempotencyKey);
        alertDelivered = true;
      } catch (emailError) {
        try {
          dependencies.onProviderFailure?.("Resend", emailError);
        } catch {
          // Provider error reporting must not block alert cleanup.
        }
      }
    }

    if (!alertDelivered) {
      try {
        await (dependencies.releaseAlert ?? releaseAlert)(claimedId);
      } catch {
        // Leave the delivery hold intact if cleanup fails; operator review is
        // safer than reclaiming a potentially accepted notification.
      }
      return false;
    }

    await (dependencies.markAlertSent ?? markAlertSent)(claimedId);
    return true;
  } catch (error) {
    if (!alertDelivered) await (dependencies.releaseAlert ?? releaseAlert)(claimedId);
    throw error;
  }
}