import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { Router, type IRouter, type RequestHandler } from "express";
import {
  CreateSubscriberBody,
  CreateSubscriberResponse,
  ResendSubscriberConfirmationBody,
  ResendSubscriberConfirmationResponse,
  ToggleShowcaseLikeBody,
  ToggleShowcaseLikeParams,
  ToggleShowcaseLikeResponse,
  UnsubscribeSubscriberQueryParams,
  VerifySubscriberQueryParams,
} from "@workspace/api-zod";
import { db, subscribersTable, submissionsTable, videoLikesTable } from "@workspace/db";
import { getPublicBaseUrl } from "../lib/integrations";
import {
  EmailDeliveryError,
  classifyEmailDeliveryFailure,
  createSubscriptionWelcomeIdempotencyKey,
  sendSubscriptionConfirmation,
  sendSubscriptionWelcome,
} from "../lib/subscriberEmail";
import {
  createUnsubscribeToken,
  createReplacementVerificationToken,
  createInitialVerificationToken,
  getConfirmationCohort,
  readConfirmationTokenMetadata,
  readUnsubscribeToken,
} from "../lib/subscriberTokens";
import { getNewsletterFunnelReport } from "../lib/newsletterFunnelAnalytics";

const router: IRouter = Router();
export const SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS = 15 * 60 * 1_000;
export const WELCOME_EMAIL_CLAIM_LEASE_MS = 15 * 60 * 1_000;
export const WELCOME_EMAIL_RECOVERY_BATCH_SIZE = 50;
export const WELCOME_EMAIL_RECOVERY_WARNING_AGE_MS = 2 * 60 * 1_000;
export const WELCOME_EMAIL_RECOVERY_REPEATED_FAILURE_ATTEMPTS = 3;
export const WELCOME_EMAIL_ADMIN_DEFAULT_PAGE_SIZE = 50;
export const WELCOME_EMAIL_ADMIN_MAX_PAGE_SIZE = 100;
export type WelcomeEmailAdminStatus =
  | "active_claim"
  | "expired_claim"
  | "failed"
  | "permanently_failed";
export type WelcomeEmailAdminRecord = {
  id: number;
  email: string;
  status: WelcomeEmailAdminStatus;
  claimedAt: Date | null;
  failedAt: Date | null;
  lastError: string | null;
  attemptCount: number;
};
export type WelcomeEmailAdminPage = {
  records: WelcomeEmailAdminRecord[];
  nextCursor: string | null;
  backlog: WelcomeEmailAdminBacklog;
};
export type WelcomeEmailRecoveryState = "clear" | "healthy" | "attention";
export type WelcomeEmailAdminBacklog = {
  retryableCount: number;
  oldestRetryAt: Date | null;
  oldestRetryAgeMinutes: number | null;
  repeatedFailureCount: number;
  state: WelcomeEmailRecoveryState;
};

export { getNewsletterFunnelReport };

export type DeferredConfirmationAdminStatus = {
  deferredCount: number;
  nextRetryAt: Date | null;
};
type SendSubscriptionWelcome = typeof sendSubscriptionWelcome;
type FinalizeSubscriberWelcome = (
  subscriberId: number,
  deliveredAt: Date,
) => Promise<void>;
type ReplacementVerificationClaim = {
  token: string;
  tokenHash: string;
  attemptId: string;
  claimedAt: Date;
};
type SubscriberConfirmationReplacementResult = {
  cohort: string | null;
  sent: boolean;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function welcomeEmailError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function isPermanentlyFailedWelcome(error: unknown): boolean {
  return error instanceof EmailDeliveryError && !error.retryable;
}

function welcomeFinalizationError(error: unknown): Error {
  return new Error(
    `Provider accepted welcome email, but final status persistence failed: ${welcomeEmailError(error)}`,
  );
}

const finalizeSubscriberWelcome: FinalizeSubscriberWelcome = async (
  subscriberId,
  deliveredAt,
) => {
  await db
    .update(subscribersTable)
    .set({
      welcomeEmailStatus: "delivered",
      welcomeEmailDeliveredAt: deliveredAt,
      welcomeEmailFailedAt: null,
      welcomeEmailLastError: null,
    })
    .where(
      and(
        eq(subscribersTable.id, subscriberId),
        eq(subscribersTable.welcomeEmailStatus, "claimed"),
      ),
    );
};

async function recordWelcomeFailure(
  subscriberId: number,
  error: unknown,
): Promise<void> {
  await db
    .update(subscribersTable)
    .set({
      welcomeEmailStatus: isPermanentlyFailedWelcome(error)
        ? "permanently_failed"
        : "failed",
      welcomeEmailFailedAt: new Date(),
      welcomeEmailLastError: welcomeEmailError(error),
    })
    .where(
      and(
        eq(subscribersTable.id, subscriberId),
        eq(subscribersTable.welcomeEmailStatus, "claimed"),
      ),
    );
}

export async function claimWelcomeEmailDelivery(
  subscriberId: number,
): Promise<boolean> {
  const [claimed] = await db
    .update(subscribersTable)
    .set({
      welcomeEmailStatus: "claimed",
      welcomeEmailClaimedAt: sql`CURRENT_TIMESTAMP`,
      welcomeEmailFailedAt: null,
      welcomeEmailLastError: null,
      welcomeEmailAttemptCount:
        sql`${subscribersTable.welcomeEmailAttemptCount} + 1`,
    })
    .where(
      and(
        eq(subscribersTable.id, subscriberId),
        isNotNull(subscribersTable.verifiedAt),
        isNull(subscribersTable.unsubscribedAt),
        or(
          isNull(subscribersTable.welcomeEmailStatus),
          eq(subscribersTable.welcomeEmailStatus, "failed"),
          and(
            eq(subscribersTable.welcomeEmailStatus, "claimed"),
            lt(
              subscribersTable.welcomeEmailClaimedAt,
              sql`CURRENT_TIMESTAMP - (${WELCOME_EMAIL_CLAIM_LEASE_MS} * interval '1 millisecond')`,
            ),
          ),
        ),
      ),
    )
    .returning({ id: subscribersTable.id });
  return Boolean(claimed);
}

export async function deliverSubscriberWelcome(
  subscriber: { id: number; email: string },
  publicBaseUrl: string,
  sendWelcome: SendSubscriptionWelcome = sendSubscriptionWelcome,
  finalizeWelcome: FinalizeSubscriberWelcome = finalizeSubscriberWelcome,
): Promise<"delivered" | "failed" | "permanently_failed" | "not_claimed"> {
  if (!(await claimWelcomeEmailDelivery(subscriber.id))) return "not_claimed";

  const unsubscribeUrl =
    `${publicBaseUrl}/api/subscribers/unsubscribe?token=${encodeURIComponent(createUnsubscribeToken(subscriber.id))}`;
  const idempotencyKey = createSubscriptionWelcomeIdempotencyKey(subscriber.id);
  let providerAccepted = false;

  try {
    await sendWelcome(subscriber.email, unsubscribeUrl, idempotencyKey);
    providerAccepted = true;
    await finalizeWelcome(subscriber.id, new Date());
    return "delivered";
  } catch (error) {
    const failure = providerAccepted ? welcomeFinalizationError(error) : error;
    try {
      await recordWelcomeFailure(subscriber.id, failure);
    } catch {
      // If the database is still unavailable, the claimed lease remains an
      // explicit retryable state. Recovery will reclaim it after the lease.
    }
    return isPermanentlyFailedWelcome(failure)
      ? "permanently_failed"
      : "failed";
  }
}

export async function recoverWelcomeEmails(
  publicBaseUrl: string,
  logOutcome: (
    outcome: "delivered" | "failed" | "permanently_failed",
    subscriberId: number,
    error?: string | null,
  ) => void,
  sendWelcome: SendSubscriptionWelcome = sendSubscriptionWelcome,
  _applicationNow = new Date(),
): Promise<void> {
  const candidates = await db
    .select({
      id: subscribersTable.id,
      email: subscribersTable.email,
    })
    .from(subscribersTable)
    .where(
      and(
        isNotNull(subscribersTable.verifiedAt),
        isNull(subscribersTable.unsubscribedAt),
        or(
          eq(subscribersTable.welcomeEmailStatus, "failed"),
          and(
            eq(subscribersTable.welcomeEmailStatus, "claimed"),
            lt(
              subscribersTable.welcomeEmailClaimedAt,
              sql`CURRENT_TIMESTAMP - (${WELCOME_EMAIL_CLAIM_LEASE_MS} * interval '1 millisecond')`,
            ),
          ),
        ),
      ),
    )
    .orderBy(subscribersTable.welcomeEmailClaimedAt)
    .limit(WELCOME_EMAIL_RECOVERY_BATCH_SIZE);

  for (const candidate of candidates) {
    const outcome = await deliverSubscriberWelcome(
      candidate,
      publicBaseUrl,
      sendWelcome,
    );
    if (outcome === "not_claimed") continue;
    const [state] = await db
      .select({ error: subscribersTable.welcomeEmailLastError })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, candidate.id));
    logOutcome(outcome, candidate.id, state?.error);
  }
}

export function classifyWelcomeEmailBacklog({
  retryableCount,
  oldestRetryAgeMinutes,
  repeatedFailureCount,
}: Pick<
  WelcomeEmailAdminBacklog,
  "retryableCount" | "oldestRetryAgeMinutes" | "repeatedFailureCount"
>): WelcomeEmailRecoveryState {
  if (retryableCount === 0) return "clear";
  if (
    retryableCount > WELCOME_EMAIL_RECOVERY_BATCH_SIZE ||
    (oldestRetryAgeMinutes !== null &&
      oldestRetryAgeMinutes * 60 * 1_000 >=
        WELCOME_EMAIL_RECOVERY_WARNING_AGE_MS) ||
    repeatedFailureCount > 0
  ) {
    return "attention";
  }
  return "healthy";
}

export async function getWelcomeEmailAdminBacklog(): Promise<WelcomeEmailAdminBacklog> {
  const { rows } = await db.execute<{
    retryableCount: number | string;
    oldestRetryAt: Date | null;
    repeatedFailureCount: number | string;
  }>(sql`
    WITH retryable AS (
      SELECT
        COALESCE(welcome_email_failed_at, welcome_email_claimed_at) AS retry_at,
        welcome_email_attempt_count
      FROM subscribers
      WHERE verified_at IS NOT NULL
        AND unsubscribed_at IS NULL
        AND welcome_email_status = 'failed'
      UNION ALL
      SELECT
        welcome_email_claimed_at AS retry_at,
        welcome_email_attempt_count
      FROM subscribers
      WHERE verified_at IS NOT NULL
        AND unsubscribed_at IS NULL
        AND welcome_email_status = 'claimed'
        AND welcome_email_claimed_at < CURRENT_TIMESTAMP
          - (${WELCOME_EMAIL_CLAIM_LEASE_MS} * interval '1 millisecond')
    )
    SELECT
      COUNT(*) AS "retryableCount",
      MIN(retry_at) AS "oldestRetryAt",
      COUNT(*) FILTER (
        WHERE welcome_email_attempt_count >=
          ${WELCOME_EMAIL_RECOVERY_REPEATED_FAILURE_ATTEMPTS}
      ) AS "repeatedFailureCount"
    FROM retryable
  `);
  const aggregate = rows[0];

  const retryableCount = Number(aggregate?.retryableCount ?? 0);
  const oldestRetryAt = aggregate?.oldestRetryAt
    ? new Date(aggregate.oldestRetryAt)
    : null;
  const oldestRetryAgeMinutes = oldestRetryAt
    ? Math.max(0, Math.floor((Date.now() - oldestRetryAt.getTime()) / 60_000))
    : null;
  const repeatedFailureCount = Number(aggregate?.repeatedFailureCount ?? 0);

  return {
    retryableCount,
    oldestRetryAt,
    oldestRetryAgeMinutes,
    repeatedFailureCount,
    state: classifyWelcomeEmailBacklog({
      retryableCount,
      oldestRetryAgeMinutes,
      repeatedFailureCount,
    }),
  };
}

export async function listWelcomeEmailAdminRecords({
  limit = WELCOME_EMAIL_ADMIN_DEFAULT_PAGE_SIZE,
  cursor,
}: {
  limit?: number;
  cursor?: string;
} = {}): Promise<WelcomeEmailAdminPage> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > WELCOME_EMAIL_ADMIN_MAX_PAGE_SIZE
  ) {
    throw new Error("Invalid welcome email admin page size");
  }

  const cursorId = cursor === undefined ? undefined : Number(cursor);
  if (
    cursorId !== undefined &&
    (!Number.isSafeInteger(cursorId) || cursorId <= 0)
  ) {
    throw new Error("Invalid welcome email admin cursor");
  }

  const conditions = [
    or(
      eq(subscribersTable.welcomeEmailStatus, "claimed"),
      eq(subscribersTable.welcomeEmailStatus, "failed"),
      eq(subscribersTable.welcomeEmailStatus, "permanently_failed"),
    ),
  ];
  if (cursorId !== undefined) {
    conditions.push(gt(subscribersTable.id, cursorId));
  }

  const rows = await db
    .select({
      id: subscribersTable.id,
      email: subscribersTable.email,
      status: sql<WelcomeEmailAdminStatus>`CASE
        WHEN ${subscribersTable.welcomeEmailStatus} = 'claimed'
          AND ${subscribersTable.welcomeEmailClaimedAt} < CURRENT_TIMESTAMP
            - (${WELCOME_EMAIL_CLAIM_LEASE_MS} * interval '1 millisecond')
          THEN 'expired_claim'
        WHEN ${subscribersTable.welcomeEmailStatus} = 'claimed'
          THEN 'active_claim'
        WHEN ${subscribersTable.welcomeEmailStatus} = 'failed'
          THEN 'failed'
        WHEN ${subscribersTable.welcomeEmailStatus} = 'permanently_failed'
          THEN 'permanently_failed'
      END`,
      claimedAt: subscribersTable.welcomeEmailClaimedAt,
      failedAt: subscribersTable.welcomeEmailFailedAt,
      lastError: subscribersTable.welcomeEmailLastError,
      attemptCount: subscribersTable.welcomeEmailAttemptCount,
    })
    .from(subscribersTable)
    .where(and(...conditions))
    .orderBy(asc(subscribersTable.id))
    .limit(limit + 1);

  const records = rows.slice(0, limit);
  return {
    records,
    nextCursor:
      rows.length > limit
        ? String(records[records.length - 1]?.id ?? "")
        : null,
    backlog: await getWelcomeEmailAdminBacklog(),
  };
}

export async function getDeferredConfirmationAdminStatus(): Promise<DeferredConfirmationAdminStatus> {
  const [aggregate] = await db
    .select({
      deferredCount: count(),
      nextRetryAt: sql<Date | null>`MIN(${subscribersTable.replacementVerificationRetryAt})`,
    })
    .from(subscribersTable)
    .where(
      and(
        isNull(subscribersTable.verifiedAt),
        isNull(subscribersTable.unsubscribedAt),
        isNotNull(subscribersTable.verificationTokenHash),
        isNotNull(subscribersTable.replacementVerificationAttemptId),
        gt(
          subscribersTable.replacementVerificationRetryAt,
          sql`CURRENT_TIMESTAMP`,
        ),
      ),
    );

  return {
    deferredCount: Number(aggregate?.deferredCount ?? 0),
    nextRetryAt: aggregate?.nextRetryAt
      ? new Date(aggregate.nextRetryAt)
      : null,
  };
}
export async function findOrCreateSubscriberByEmail(email: string) {
  const canonicalEmail = email.trim().toLowerCase();
  const findSubscriber = () =>
    db
      .select()
      .from(subscribersTable)
      .where(sql`lower(trim(${subscribersTable.email})) = ${canonicalEmail}`)
      .limit(1);

  const [existing] = await findSubscriber();
  if (existing) return existing;

  const [created] = await db
    .insert(subscribersTable)
    .values({
      email: canonicalEmail,
      unsubscribeTokenHash: hash(token()),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [concurrentlyCreated] = await findSubscriber();
  if (!concurrentlyCreated) {
    throw new Error("Subscriber could not be created");
  }
  return concurrentlyCreated;
}

export async function claimSubscriberVerification(
  subscriberId: number,
  email: string,
): Promise<string | null> {
  const verificationToken = createInitialVerificationToken(token());
  const [claimed] = await db
    .update(subscribersTable)
    .set({
      email: email.trim().toLowerCase(),
      verificationTokenHash: hash(verificationToken),
      replacementVerificationAttemptId: null,
      replacementVerificationRetryAt: null,
      unsubscribeTokenHash: hash(token()),
      verifiedAt: null,
      unsubscribedAt: null,
      welcomeEmailStatus: null,
      welcomeEmailClaimedAt: null,
      welcomeEmailDeliveredAt: null,
      welcomeEmailFailedAt: null,
      welcomeEmailLastError: null,
      welcomeEmailAttemptCount: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(subscribersTable.id, subscriberId),
        isNull(subscribersTable.verificationTokenHash),
      ),
    )
    .returning({ id: subscribersTable.id });

  return claimed ? verificationToken : null;
}

export async function claimReplacementSubscriberVerification(
  subscriberId: number,
  email: string,
): Promise<ReplacementVerificationClaim | null> {
  const [pending] = await db
    .select({
      verificationTokenHash: subscribersTable.verificationTokenHash,
      replacementVerificationAttemptId:
        subscribersTable.replacementVerificationAttemptId,
      replacementVerificationRetryAt:
        subscribersTable.replacementVerificationRetryAt,
      updatedAt: subscribersTable.updatedAt,
    })
    .from(subscribersTable)
    .where(
      and(
        eq(subscribersTable.id, subscriberId),
        isNull(subscribersTable.verifiedAt),
        isNull(subscribersTable.unsubscribedAt),
        isNotNull(subscribersTable.verificationTokenHash),
        sql`(
          ${subscribersTable.replacementVerificationAttemptId} is not null
          or ${subscribersTable.updatedAt} <= CURRENT_TIMESTAMP - (${SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS} * interval '1 millisecond')
        )`,
      ),
    )
    .limit(1);
  if (!pending?.verificationTokenHash) return null;

  if (pending.replacementVerificationAttemptId) {
    const verificationToken = createReplacementVerificationToken(
      subscriberId,
      pending.replacementVerificationAttemptId,
    );
    if (hash(verificationToken) !== pending.verificationTokenHash) return null;
    const [retryClaimed] = await db
      .update(subscribersTable)
      .set({
        replacementVerificationRetryAt: sql`CURRENT_TIMESTAMP + (${SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS} * interval '1 millisecond')`,
      })
      .where(
        and(
          eq(subscribersTable.id, subscriberId),
          isNull(subscribersTable.verifiedAt),
          isNull(subscribersTable.unsubscribedAt),
          eq(
            subscribersTable.verificationTokenHash,
            pending.verificationTokenHash,
          ),
          eq(
            subscribersTable.replacementVerificationAttemptId,
            pending.replacementVerificationAttemptId,
          ),
          or(
            isNull(subscribersTable.replacementVerificationRetryAt),
            lte(
              subscribersTable.replacementVerificationRetryAt,
              sql`CURRENT_TIMESTAMP`,
            ),
          ),
        ),
      )
      .returning({ id: subscribersTable.id });
    if (!retryClaimed) return null;
    return {
      token: verificationToken,
      tokenHash: pending.verificationTokenHash,
      attemptId: pending.replacementVerificationAttemptId,
      claimedAt: pending.updatedAt,
    };
  }

  const attemptId = `${getConfirmationCohort()}~${token()}`;
  const verificationToken = createReplacementVerificationToken(
    subscriberId,
    attemptId,
  );
  const verificationTokenHash = hash(verificationToken);
  const [claimed] = await db
    .update(subscribersTable)
    .set({
      email: email.trim().toLowerCase(),
      verificationTokenHash,
      replacementVerificationAttemptId: attemptId,
      replacementVerificationRetryAt: sql`CURRENT_TIMESTAMP + (${SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS} * interval '1 millisecond')`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(subscribersTable.id, subscriberId),
        isNull(subscribersTable.verifiedAt),
        isNull(subscribersTable.unsubscribedAt),
        eq(
          subscribersTable.verificationTokenHash,
          pending.verificationTokenHash,
        ),
        isNull(subscribersTable.replacementVerificationAttemptId),
        sql`${subscribersTable.updatedAt} <= CURRENT_TIMESTAMP - (${SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS} * interval '1 millisecond')`,
      ),
    )
    .returning({
      id: subscribersTable.id,
      updatedAt: subscribersTable.updatedAt,
    });

  return claimed
    ? {
        token: verificationToken,
        tokenHash: verificationTokenHash,
        attemptId,
        claimedAt: claimed.updatedAt,
      }
    : null;
}

async function requestSubscriberConfirmationReplacementWithCohort(
  email: string,
  host: string | undefined,
  sendConfirmation = sendSubscriptionConfirmation,
): Promise<SubscriberConfirmationReplacementResult | null> {
  const canonicalEmail = email.trim().toLowerCase();
  const [subscriber] = await db
    .select()
    .from(subscribersTable)
    .where(sql`lower(trim(${subscribersTable.email})) = ${canonicalEmail}`)
    .limit(1);
  const claim = subscriber
    ? await claimReplacementSubscriberVerification(
        subscriber.id,
        canonicalEmail,
      )
    : null;
  if (!subscriber) return null;
  if (!claim) {
    const cohort = subscriber.replacementVerificationAttemptId?.split("~", 1)[0];
    return cohort ? { cohort, sent: false } : null;
  }

  const baseUrl = getPublicBaseUrl(host);
  await sendConfirmation(
    canonicalEmail,
    `${baseUrl}/api/subscribers/verify?token=${encodeURIComponent(claim.token)}`,
    `subscriber-confirmation-replacement-${subscriber.id}-${claim.attemptId}`,
  );
  await db
    .update(subscribersTable)
    .set({
      replacementVerificationAttemptId: null,
      replacementVerificationRetryAt: null,
      updatedAt: claim.claimedAt,
    })
    .where(
      and(
        eq(subscribersTable.id, subscriber.id),
        eq(subscribersTable.verificationTokenHash, claim.tokenHash),
        eq(
          subscribersTable.replacementVerificationAttemptId,
          claim.attemptId,
        ),
      ),
    );
  return {
    cohort: readConfirmationTokenMetadata(claim.token).cohort,
    sent: true,
  };
}

export async function requestSubscriberConfirmationReplacement(
  email: string,
  host: string | undefined,
  sendConfirmation = sendSubscriptionConfirmation,
): Promise<boolean> {
  const result = await requestSubscriberConfirmationReplacementWithCohort(
    email,
    host,
    sendConfirmation,
  );
  return result?.sent ?? false;
}

function resultPage(title: string, copy: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body style="margin:0;background:#f7f7f2;font-family:Arial,sans-serif;color:#10182b"><main style="max-width:620px;margin:12vh auto;padding:32px"><div style="font-weight:900;color:#ff4b00;letter-spacing:.08em">TOP DOG TRICKS</div><h1 style="font-size:44px;line-height:1;margin:24px 0 16px">${title}</h1><p style="font-size:18px;line-height:1.6">${copy}</p><a href="/" style="display:inline-block;margin-top:22px;color:#ff4b00;font-weight:800">Back to Top Dog Tricks →</a></main></body></html>`;
}

export function createVerifySubscriberHandler(
  sendWelcome: SendSubscriptionWelcome = sendSubscriptionWelcome,
): RequestHandler {
  return async (req, res): Promise<void> => {
    res.set("Cache-Control", "no-store");
    const query = VerifySubscriberQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).type("html").send(resultPage("That link isn’t valid.", "Please request a fresh subscription link from the homepage."));
      return;
    }
    const confirmation = readConfirmationTokenMetadata(query.data.token);
    const [subscriber] = await db
      .update(subscribersTable)
      .set({
        verifiedAt: new Date(),
        verificationTokenHash: null,
        replacementVerificationAttemptId: null,
        replacementVerificationRetryAt: null,
        unsubscribedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            subscribersTable.verificationTokenHash,
            hash(query.data.token),
          ),
          isNull(subscribersTable.verifiedAt),
        ),
      )
      .returning({
        id: subscribersTable.id,
        email: subscribersTable.email,
      });
    if (!subscriber) {
      res.status(400).type("html").send(resultPage("That link has expired.", "Please request a fresh subscription link from the homepage."));
      return;
    }

    await db
      .update(subscribersTable)
      .set({
        unsubscribeTokenHash: hash(createUnsubscribeToken(subscriber.id)),
      })
      .where(eq(subscribersTable.id, subscriber.id));

    const outcome = await deliverSubscriberWelcome(
      subscriber,
      getPublicBaseUrl(req.get("host")),
      sendWelcome,
    );
    if (outcome !== "delivered") {
      req.log?.warn(
        { outcome, subscriberId: subscriber.id },
        "Subscription welcome email was not delivered",
      );
    }
    const redirect = new URL("/", `${getPublicBaseUrl(req.get("host"))}/`);
    redirect.searchParams.set("subscription", "confirmed");
    redirect.searchParams.set("confirmation_source", confirmation.source);
    if (confirmation.cohort) {
      redirect.searchParams.set("confirmation_cohort", confirmation.cohort);
    } else {
      redirect.searchParams.set("confirmation_history", "legacy");
    }
    redirect.hash = "newsletter";
    res.redirect(303, redirect.pathname + redirect.search + redirect.hash);
  };
}

router.post("/showcase/:id/like", async (req, res): Promise<void> => {
  const params = ToggleShowcaseLikeParams.safeParse(req.params);
  const body = ToggleShowcaseLikeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid like request" });
    return;
  }

  const [submission] = await db.select({ id: submissionsTable.id }).from(submissionsTable).where(and(
    eq(submissionsTable.id, params.data.id),
    eq(submissionsTable.status, "approved"),
    eq(submissionsTable.processingStatus, "completed"),
  ));
  if (!submission) {
    res.status(404).json({ error: "Approved video not found" });
    return;
  }

  const browserHash = hash(body.data.browserId);
  const [existing] = await db.select({ id: videoLikesTable.id }).from(videoLikesTable).where(and(
    eq(videoLikesTable.submissionId, submission.id),
    eq(videoLikesTable.browserHash, browserHash),
  ));
  const liked = !existing;
  if (existing) {
    await db.delete(videoLikesTable).where(eq(videoLikesTable.id, existing.id));
  } else {
    await db.insert(videoLikesTable).values({ submissionId: submission.id, browserHash });
  }
  const [total] = await db.select({ value: count() }).from(videoLikesTable).where(eq(videoLikesTable.submissionId, submission.id));
  res.json(ToggleShowcaseLikeResponse.parse({ submissionId: submission.id, liked, likeCount: total?.value ?? 0 }));
});

router.post("/subscribers", async (req, res): Promise<void> => {
  const body = CreateSubscriberBody.safeParse(req.body);
  if (!body.success || body.data.consent !== true) {
    res.status(400).json({ error: "Email and consent are required" });
    return;
  }

  const email = body.data.email.trim().toLowerCase();
  const existing = await findOrCreateSubscriberByEmail(email);
  if (existing?.verifiedAt && !existing.unsubscribedAt) {
    res.status(202).json(
      CreateSubscriberResponse.parse({
        message: "You’re already subscribed.",
        cohort: getConfirmationCohort(),
      }),
    );
    return;
  }

  const confirmationCohort = getConfirmationCohort();
  const verificationToken = await claimSubscriberVerification(existing.id, email);

  if (verificationToken) {
    const baseUrl = getPublicBaseUrl(req.get("host"));
    try {
      await sendSubscriptionConfirmation(email, `${baseUrl}/api/subscribers/verify?token=${encodeURIComponent(verificationToken)}`);
    } catch (error) {
      await db
        .update(subscribersTable)
        .set({ verificationTokenHash: null, updatedAt: new Date() })
        .where(
          and(
            eq(subscribersTable.id, existing.id),
            eq(subscribersTable.verificationTokenHash, hash(verificationToken)),
          ),
        );
      req.log?.error(
        {
          event: "subscriber_confirmation_delivery_failed",
          classification: classifyEmailDeliveryFailure(error),
        },
        "Subscriber confirmation email delivery failed",
      );
      res.status(500).json({ error: "Unable to send confirmation email" });
      return;
    }
  }
  res.status(202).json(
    CreateSubscriberResponse.parse({
      message: "Check your inbox to confirm your subscription.",
      cohort: confirmationCohort,
    }),
  );
});

router.post("/subscribers/resend", async (req, res): Promise<void> => {
  const body = ResendSubscriberConfirmationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }

  let confirmationCohort: string | null;
  try {
    const result = await requestSubscriberConfirmationReplacementWithCohort(
      body.data.email,
      req.get("host"),
    );
    confirmationCohort = result?.cohort ?? null;
  } catch (error) {
    req.log?.error(
      {
        event: "subscriber_confirmation_delivery_failed",
        classification: classifyEmailDeliveryFailure(error),
      },
      "Subscriber confirmation email delivery failed",
    );
    res.status(500).json({ error: "Unable to send confirmation email" });
    return;
  }

  res.status(202).json(
    ResendSubscriberConfirmationResponse.parse({
      message: "If that subscription is still pending and eligible, a fresh confirmation email is on its way.",
      cohort: confirmationCohort ?? getConfirmationCohort(),
    }),
  );
});

router.get("/subscribers/verify", createVerifySubscriberHandler());

router.get("/subscribers/unsubscribe", async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  const query = UnsubscribeSubscriberQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).type("html").send(resultPage("That link isn’t valid.", "No subscription was changed."));
    return;
  }
  const signedSubscriberId = readUnsubscribeToken(query.data.token);
  const [subscriber] = await db
    .select()
    .from(subscribersTable)
    .where(
      signedSubscriberId
        ? eq(subscribersTable.id, signedSubscriberId)
        : eq(subscribersTable.unsubscribeTokenHash, hash(query.data.token)),
    );
  if (!subscriber) {
    res.status(400).type("html").send(resultPage("That link has expired.", "No active subscription was found."));
    return;
  }
  await db.update(subscribersTable).set({ unsubscribedAt: new Date(), updatedAt: new Date() }).where(eq(subscribersTable.id, subscriber.id));
  res.type("html").send(resultPage("You’re unsubscribed.", "You won’t receive more Top Dog Tricks emails."));
});

export default router;
