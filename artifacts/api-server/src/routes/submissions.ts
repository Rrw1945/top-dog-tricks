import { and, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateSubmissionBody,
  CreateSubmissionResponse,
  AnalyzeSubmissionParams,
  AnalyzeSubmissionResponse,
  GetDashboardSummaryResponse,
  GetSubmissionParams,
  GetSubmissionResponse,
  ListSubmissionsQueryParams,
  ListSubmissionsResponse,
  ListShowcaseEntriesResponse,
  UpdateSubmissionBody,
  UpdateSubmissionParams,
  UpdateSubmissionResponse,
} from "@workspace/api-zod";
import {
  db,
  spotlightNotificationsTable,
  submissionsTable,
  subscribersTable,
  videoLikesTable,
} from "@workspace/db";
import { isAdminAuthenticated } from "../lib/adminSession";
import {
  getPublicBaseUrl,
  sendSlackPreview,
  syncSubmissionToExternalSystems,
  updateAirtableProcessedMedia,
  updateAirtableSubmission,
} from "../lib/integrations";
import { processSubmissionMedia } from "../lib/mediaProcessing";
import { analyzeSubmissionVideo } from "../lib/videoAnalysis";
import { sendSpotlightNotification } from "../lib/subscriberEmail";
import { createUnsubscribeToken } from "../lib/subscriberTokens";

const router: IRouter = Router();
const ANALYSIS_LEASE_MS = 20 * 60 * 1_000;
export const SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS = 15 * 60 * 1_000;
export const SPOTLIGHT_NOTIFICATION_RECOVERY_BATCH_SIZE = 50;

export type RecoverableSpotlightNotification = {
  submissionId: number;
  trickName: string;
  subscriberId: number;
  email: string;
};

export async function listRecoverableSpotlightNotifications(
  _applicationNow = new Date(),
): Promise<RecoverableSpotlightNotification[]> {
  return db
    .select({
      submissionId: submissionsTable.id,
      trickName: submissionsTable.trickName,
      subscriberId: subscribersTable.id,
      email: subscribersTable.email,
    })
    .from(spotlightNotificationsTable)
    .innerJoin(
      submissionsTable,
      eq(spotlightNotificationsTable.submissionId, submissionsTable.id),
    )
    .innerJoin(
      subscribersTable,
      eq(spotlightNotificationsTable.subscriberId, subscribersTable.id),
    )
    .where(
      and(
        eq(submissionsTable.status, "approved"),
        eq(submissionsTable.processingStatus, "completed"),
        isNotNull(subscribersTable.verifiedAt),
        isNull(subscribersTable.unsubscribedAt),
        or(
          eq(spotlightNotificationsTable.status, "failed"),
          and(
            eq(spotlightNotificationsTable.status, "claimed"),
            lt(
              spotlightNotificationsTable.claimedAt,
              sql`CURRENT_TIMESTAMP - (${SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS} * interval '1 millisecond')`,
            ),
          ),
        ),
      ),
    )
    .orderBy(spotlightNotificationsTable.claimedAt)
    .limit(SPOTLIGHT_NOTIFICATION_RECOVERY_BATCH_SIZE);
}

export async function claimSpotlightNotificationDelivery(
  submissionId: number,
  subscriberId: number,
  _applicationNow = new Date(),
): Promise<number | null> {
  const [claimed] = await db
    .insert(spotlightNotificationsTable)
    .values({
      submissionId,
      subscriberId,
      status: "claimed",
      claimedAt: sql`CURRENT_TIMESTAMP`,
    })
    .onConflictDoNothing()
    .returning({ id: spotlightNotificationsTable.id });
  if (claimed) return claimed.id;

  const [retried] = await db
    .update(spotlightNotificationsTable)
    .set({
      status: "claimed",
      claimedAt: sql`CURRENT_TIMESTAMP`,
      failedAt: null,
      lastError: null,
      attemptCount: sql`${spotlightNotificationsTable.attemptCount} + 1`,
    })
    .where(
      and(
        eq(spotlightNotificationsTable.submissionId, submissionId),
        eq(spotlightNotificationsTable.subscriberId, subscriberId),
        or(
          eq(spotlightNotificationsTable.status, "failed"),
          and(
            eq(spotlightNotificationsTable.status, "claimed"),
            lt(
              spotlightNotificationsTable.claimedAt,
              sql`CURRENT_TIMESTAMP - (${SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS} * interval '1 millisecond')`,
            ),
          ),
        ),
      ),
    )
    .returning({ id: spotlightNotificationsTable.id });
  return retried?.id ?? null;
}

type NotificationFailureLogger = (
  error: unknown,
  subscriberId?: number,
) => void;

export type SpotlightSubscriber = {
  id: number;
  email: string;
};

export type SubscriberEligibility = {
  verifiedAt: Date | null;
  unsubscribedAt: Date | null;
};

export function isEligibleSpotlightSubscriber(
  subscriber: SubscriberEligibility,
): boolean {
  return subscriber.verifiedAt !== null && subscriber.unsubscribedAt === null;
}

export type SpotlightNotificationDependencies = {
  listEligibleSubscribers: () => Promise<SpotlightSubscriber[]>;
  claimDelivery: (
    submissionId: number,
    subscriberId: number,
  ) => Promise<number | null>;
  markDelivered: (notificationId: number) => Promise<void>;
  markFailed: (notificationId: number, error: unknown) => Promise<void>;
  sendNotification: (
    email: string,
    trickName: string,
    showcaseUrl: string,
    unsubscribeUrl: string,
    idempotencyKey: string,
  ) => Promise<void>;
  createToken: (subscriberId: number) => string;
};

export async function deliverSpotlightNotifications(
  submission: Pick<typeof submissionsTable.$inferSelect, "id" | "trickName">,
  publicBaseUrl: string,
  logFailure: NotificationFailureLogger,
  dependencies: SpotlightNotificationDependencies,
): Promise<void> {
  try {
    const subscribers = await dependencies.listEligibleSubscribers();
    for (const subscriber of subscribers) {
      try {
        const notificationId = await dependencies.claimDelivery(
          submission.id,
          subscriber.id,
        );
        if (notificationId === null) continue;

        const unsubscribeToken = dependencies.createToken(subscriber.id);
        try {
          await dependencies.sendNotification(
            subscriber.email,
            submission.trickName,
            `${publicBaseUrl}/#showcase`,
            `${publicBaseUrl}/api/subscribers/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
            `spotlight-notification-${notificationId}`,
          );
          await dependencies.markDelivered(notificationId);
        } catch (error) {
          try {
            await dependencies.markFailed(notificationId, error);
          } catch (markError) {
            logFailure(markError, subscriber.id);
          }
          throw error;
        }
      } catch (error) {
        logFailure(error, subscriber.id);
      }
    }
  } catch (error) {
    logFailure(error);
  }
}

function deriveTrickName(description: string): string {
  const clean = description.trim().replace(/\s+/g, " ");
  const firstPhrase = clean.split(/[.!?,;:]/, 1)[0]?.trim() || clean;
  const words = firstPhrase.split(" ");
  const concise = words.slice(0, 6).join(" ");
  return concise.length <= 64 ? concise : `${concise.slice(0, 61).trimEnd()}…`;
}

function requireAdmin(req: Request, res: Response): boolean {
  if (isAdminAuthenticated(req)) return true;
  res.status(401).json({ error: "Admin authentication required" });
  return false;
}

async function syncSubmissionAutomation(
  submissionId: number,
  publicBaseUrl: string,
): Promise<void> {
  const [submission] = await db
    .select()
    .from(submissionsTable)
    .where(eq(submissionsTable.id, submissionId));
  if (!submission) return;

  const external = await syncSubmissionToExternalSystems(
    submission,
    publicBaseUrl,
  );
  await db
    .update(submissionsTable)
    .set({
      driveReleaseFileId: external.driveReleaseFileId,
      driveReleaseUrl: external.driveReleaseUrl,
      airtableContestantId: external.airtableContestantId,
      airtableSubmissionId: external.airtableSubmissionId,
      processingError: external.errors.length ? external.errors.join("\n") : null,
      updatedAt: new Date(),
    })
    .where(eq(submissionsTable.id, submissionId));

  await db
    .update(submissionsTable)
    .set({ processingStatus: "awaiting_review", updatedAt: new Date() })
    .where(
      and(
        eq(submissionsTable.id, submissionId),
        eq(submissionsTable.status, "pending"),
      ),
    );
}

async function notifySpotlightSubscribers(
  submission: typeof submissionsTable.$inferSelect,
  publicBaseUrl: string,
  logFailure: NotificationFailureLogger,
): Promise<void> {
  await deliverSpotlightNotifications(submission, publicBaseUrl, logFailure, {
    listEligibleSubscribers: () =>
      db
      .select({
        id: subscribersTable.id,
        email: subscribersTable.email,
      })
      .from(subscribersTable)
      .where(
        and(
          isNotNull(subscribersTable.verifiedAt),
          isNull(subscribersTable.unsubscribedAt),
        ),
      ),
    claimDelivery: claimSpotlightNotificationDelivery,
    markDelivered: async (notificationId) => {
      const deliveredAt = new Date();
      await db
        .update(spotlightNotificationsTable)
        .set({
          status: "delivered",
          deliveredAt,
          sentAt: deliveredAt,
          failedAt: null,
          lastError: null,
        })
        .where(
          and(
            eq(spotlightNotificationsTable.id, notificationId),
            eq(spotlightNotificationsTable.status, "claimed"),
          ),
        );
    },
    markFailed: async (notificationId, error) => {
      await db
        .update(spotlightNotificationsTable)
        .set({
          status: "failed",
          failedAt: new Date(),
          lastError: (error instanceof Error ? error.message : String(error)).slice(
            0,
            2_000,
          ),
        })
        .where(
          and(
            eq(spotlightNotificationsTable.id, notificationId),
            eq(spotlightNotificationsTable.status, "claimed"),
          ),
        );
    },
    sendNotification: sendSpotlightNotification,
    createToken: createUnsubscribeToken,
  });
}

export async function recoverSpotlightNotifications(
  publicBaseUrl: string,
  logFailure: (
    error: unknown,
    submissionId?: number,
    subscriberId?: number,
  ) => void,
): Promise<void> {
  let candidates: RecoverableSpotlightNotification[];

  try {
    candidates = await listRecoverableSpotlightNotifications();
  } catch (error) {
    logFailure(error);
    return;
  }

  for (const candidate of candidates) {
    await deliverSpotlightNotifications(
      { id: candidate.submissionId, trickName: candidate.trickName },
      publicBaseUrl,
      (error, subscriberId) =>
        logFailure(error, candidate.submissionId, subscriberId),
      {
        listEligibleSubscribers: async () => [
          { id: candidate.subscriberId, email: candidate.email },
        ],
        claimDelivery: claimSpotlightNotificationDelivery,
        markDelivered: async (notificationId) => {
          const deliveredAt = new Date();
          await db
            .update(spotlightNotificationsTable)
            .set({
              status: "delivered",
              deliveredAt,
              sentAt: deliveredAt,
              failedAt: null,
              lastError: null,
            })
            .where(
              and(
                eq(spotlightNotificationsTable.id, notificationId),
                eq(spotlightNotificationsTable.status, "claimed"),
              ),
            );
        },
        markFailed: async (notificationId, error) => {
          await db
            .update(spotlightNotificationsTable)
            .set({
              status: "failed",
              failedAt: new Date(),
              lastError: (
                error instanceof Error ? error.message : String(error)
              ).slice(0, 2_000),
            })
            .where(
              and(
                eq(spotlightNotificationsTable.id, notificationId),
                eq(spotlightNotificationsTable.status, "claimed"),
              ),
            );
        },
        sendNotification: sendSpotlightNotification,
        createToken: createUnsubscribeToken,
      },
    );
  }
}

async function runApprovedProduction(
  submissionId: number,
  publicBaseUrl: string,
  logNotificationFailure: NotificationFailureLogger,
): Promise<void> {
  const [submission] = await db
    .select()
    .from(submissionsTable)
    .where(eq(submissionsTable.id, submissionId));
  if (!submission || submission.status !== "approved") return;

  try {
    const assets = await processSubmissionMedia(submission);
    const processedSubmission = {
      ...submission,
      processedVideoObjectPath: assets.processedVideoObjectPath,
      voiceoverObjectPath: assets.voiceoverObjectPath,
    };
    const postProcessingErrors: string[] = [];
    try {
      await updateAirtableProcessedMedia(processedSubmission, publicBaseUrl);
    } catch (error) {
      postProcessingErrors.push(
        `Airtable media update: ${error instanceof Error ? error.message : "update failed"}`,
      );
    }
    try {
      await sendSlackPreview(processedSubmission, publicBaseUrl);
    } catch (error) {
      postProcessingErrors.push(
        `Slack preview: ${error instanceof Error ? error.message : "send failed"}`,
      );
    }
    const [completedSubmission] = await db
      .update(submissionsTable)
      .set({
        processingStatus: "completed",
        processedVideoObjectPath: assets.processedVideoObjectPath,
        voiceoverObjectPath: assets.voiceoverObjectPath,
        processingError: postProcessingErrors
          .filter(Boolean)
          .join("\n") || null,
        updatedAt: new Date(),
      })
      .where(eq(submissionsTable.id, submissionId))
      .returning();

    if (completedSubmission) {
      await notifySpotlightSubscribers(
        completedSubmission,
        publicBaseUrl,
        logNotificationFailure,
      );
    }
  } catch (error) {
    await db
      .update(submissionsTable)
      .set({
        processingStatus: "failed",
        processingError: [
          `Media processing: ${error instanceof Error ? error.message : "processing failed"}`,
        ]
          .filter(Boolean)
          .join("\n"),
        updatedAt: new Date(),
      })
      .where(eq(submissionsTable.id, submissionId));
  }
}

router.post("/submissions", async (req, res): Promise<void> => {
  const parsed = CreateSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid submission fields" });
    return;
  }

  const [submission] = await db
    .insert(submissionsTable)
    .values({
      ...parsed.data,
      breedBio: parsed.data.breedBio ?? null,
      phone: parsed.data.phone?.trim() ?? "",
      trickName:
        parsed.data.trickName?.trim() ||
        deriveTrickName(parsed.data.trickDescription),
    })
    .returning();

  try {
    const publicBaseUrl = getPublicBaseUrl(req.get("host"));
    void syncSubmissionAutomation(submission.id, publicBaseUrl).catch((error) => {
      req.log.error(
        { err: error, submissionId: submission.id },
        "Submission automation failed unexpectedly",
      );
    });
  } catch (error) {
    req.log.error(
      { err: error, submissionId: submission.id },
      "Submission automation could not start",
    );
  }

  res.status(201).json(CreateSubmissionResponse.parse(submission));
});

router.get("/submissions", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const query = ListSubmissionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid submission filter" });
    return;
  }

  const rows = query.data.status
    ? await db
        .select()
        .from(submissionsTable)
        .where(eq(submissionsTable.status, query.data.status))
        .orderBy(desc(submissionsTable.submittedAt))
    : await db
        .select()
        .from(submissionsTable)
        .orderBy(desc(submissionsTable.submittedAt));

  res.json(ListSubmissionsResponse.parse(rows));
});

router.get("/submissions/:id", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const params = GetSubmissionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid submission id" });
    return;
  }

  const [submission] = await db
    .select()
    .from(submissionsTable)
    .where(eq(submissionsTable.id, params.data.id));

  if (!submission) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  res.json(GetSubmissionResponse.parse(submission));
});

router.post("/submissions/:id/analyze", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const params = AnalyzeSubmissionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid submission id" });
    return;
  }

  const [submission] = await db
    .select()
    .from(submissionsTable)
    .where(eq(submissionsTable.id, params.data.id));
  if (!submission) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }
  const runId = crypto.randomUUID();
  const claimedAt = new Date();
  const staleBefore = new Date(claimedAt.getTime() - ANALYSIS_LEASE_MS);
  const [claimedSubmission] = await db
    .update(submissionsTable)
    .set({
      aiAnalysisStatus: "analyzing",
      aiAnalysisRunId: runId,
      aiAnalysisStartedAt: claimedAt,
      aiAnalysisHeartbeatAt: claimedAt,
      aiAnalysisChunksCompleted: 0,
      aiAnalysisChunksTotal: null,
      aiAnalysisError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(submissionsTable.id, submission.id),
        or(
          ne(submissionsTable.aiAnalysisStatus, "analyzing"),
          isNull(submissionsTable.aiAnalysisHeartbeatAt),
          lt(submissionsTable.aiAnalysisHeartbeatAt, staleBefore),
        ),
      ),
    )
    .returning();
  if (!claimedSubmission) {
    res.status(409).json({ error: "This video is already being analyzed" });
    return;
  }

  try {
    const analysis = await analyzeSubmissionVideo(
      claimedSubmission,
      async (completed, total) => {
        await db
          .update(submissionsTable)
          .set({
            aiAnalysisChunksCompleted: completed,
            aiAnalysisChunksTotal: total,
            aiAnalysisHeartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(submissionsTable.id, submission.id),
              eq(submissionsTable.aiAnalysisRunId, runId),
            ),
          );
      },
    );
    const [updated] = await db
      .update(submissionsTable)
      .set({
        aiAnalysisStatus: "completed",
        aiTrimStartSeconds: analysis.trimStartSeconds,
        aiTrimEndSeconds: analysis.trimEndSeconds,
        aiDetectedAction: analysis.detectedAction,
        aiPunchlines: JSON.stringify(analysis.punchlines),
        aiConfidence: analysis.confidence,
        aiAnalysisError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(submissionsTable.id, submission.id),
          eq(submissionsTable.aiAnalysisRunId, runId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(409).json({ error: "This analysis run was replaced by a retry" });
      return;
    }
    res.json(AnalyzeSubmissionResponse.parse(updated));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Video analysis failed";
    await db
      .update(submissionsTable)
      .set({
        aiAnalysisStatus: "failed",
        aiAnalysisError: message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(submissionsTable.id, submission.id),
          eq(submissionsTable.aiAnalysisRunId, runId),
        ),
      );
    req.log.error({ err: error, submissionId: submission.id }, "Gemini video analysis failed");
    res.status(500).json({ error: message });
  }
});

router.post(
  "/submissions/:id/notifications/retry",
  async (req, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;

    const params = GetSubmissionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid submission id" });
      return;
    }

    const [submission] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, params.data.id));
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    if (
      submission.status !== "approved" ||
      submission.processingStatus !== "completed"
    ) {
      res.status(409).json({
        error: "Spotlight notifications can only be retried for completed videos",
      });
      return;
    }

    const publicBaseUrl = getPublicBaseUrl(req.get("host"));
    await notifySpotlightSubscribers(
      submission,
      publicBaseUrl,
      (error, subscriberId) => {
        req.log.error(
          { err: error, submissionId: submission.id, subscriberId },
          "Spotlight subscriber notification retry failed",
        );
      },
    );
    res.json({ retried: true });
  },
);

router.get("/showcase", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: submissionsTable.id,
      dogName: submissionsTable.dogName,
      breedBio: submissionsTable.breedBio,
      trickName: submissionsTable.trickName,
      trickDescription: submissionsTable.trickDescription,
      videoObjectPath: submissionsTable.videoObjectPath,
      processedVideoObjectPath: submissionsTable.processedVideoObjectPath,
      voiceoverObjectPath: submissionsTable.voiceoverObjectPath,
      punchline: submissionsTable.punchline,
      publishedAt: submissionsTable.updatedAt,
    })
    .from(submissionsTable)
    .where(
      and(
        eq(submissionsTable.status, "approved"),
        eq(submissionsTable.processingStatus, "completed"),
        isNotNull(submissionsTable.processedVideoObjectPath),
      ),
    )
    .orderBy(desc(submissionsTable.updatedAt));

  const likeRows = rows.length
    ? await db
        .select({ submissionId: videoLikesTable.submissionId, likeCount: count() })
        .from(videoLikesTable)
        .where(inArray(videoLikesTable.submissionId, rows.map((row) => row.id)))
        .groupBy(videoLikesTable.submissionId)
    : [];
  const likeCounts = new Map(likeRows.map((row) => [row.submissionId, row.likeCount]));
  res.json(ListShowcaseEntriesResponse.parse(rows.map((row) => ({ ...row, likeCount: likeCounts.get(row.id) ?? 0 }))));
});

router.patch("/submissions/:id", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const params = UpdateSubmissionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid submission id" });
    return;
  }

  const body = UpdateSubmissionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid review update" });
    return;
  }

  const [current] = await db
    .select()
    .from(submissionsTable)
    .where(eq(submissionsTable.id, params.data.id));
  if (!current) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  const nextTrimStart = body.data.trimStartSeconds ?? current.trimStartSeconds;
  const nextTrimEnd = body.data.trimEndSeconds ?? current.trimEndSeconds;
  if (
    nextTrimStart !== null &&
    nextTrimEnd !== null &&
    nextTrimEnd <= nextTrimStart
  ) {
    res.status(400).json({ error: "Trim end must be after trim start" });
    return;
  }

  const shouldProduce =
    body.data.status === "approved" &&
    (current.status !== "approved" ||
      current.processingStatus === "failed" ||
      current.processedVideoObjectPath === null);
  const updates = {
    ...(body.data.status !== undefined ? { status: body.data.status } : {}),
    ...(body.data.punchline !== undefined
      ? { punchline: body.data.punchline }
      : {}),
    ...(body.data.trimStartSeconds !== undefined
      ? { trimStartSeconds: body.data.trimStartSeconds }
      : {}),
    ...(body.data.trimEndSeconds !== undefined
      ? { trimEndSeconds: body.data.trimEndSeconds }
      : {}),
    ...(shouldProduce
      ? { processingStatus: "processing", processingError: null }
      : {}),
    updatedAt: new Date(),
  };

  const [submission] = await db
    .update(submissionsTable)
    .set(updates)
    .where(eq(submissionsTable.id, params.data.id))
    .returning();

  if (!submission) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  try {
    await updateAirtableSubmission(submission);
  } catch (error) {
    req.log.error(
      { err: error, submissionId: submission.id },
      "Airtable review update failed",
    );
  }

  if (shouldProduce) {
    const publicBaseUrl = getPublicBaseUrl(req.get("host"));
    void runApprovedProduction(
      submission.id,
      publicBaseUrl,
      (error, subscriberId) => {
        req.log.error(
          { err: error, submissionId: submission.id, subscriberId },
          "Spotlight subscriber notification failed",
        );
      },
    ).catch((error) => {
      req.log.error(
        { err: error, submissionId: submission.id },
        "Approved video production failed unexpectedly",
      );
    });
  }

  res.json(UpdateSubmissionResponse.parse(submission));
});

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const rows = await db.select({ status: submissionsTable.status }).from(submissionsTable);
  const summary = rows.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.status === "pending") acc.pending += 1;
      if (row.status === "approved") acc.approved += 1;
      if (row.status === "needs_edit") acc.needsEdit += 1;
      if (row.status === "rejected") acc.rejected += 1;
      return acc;
    },
    { total: 0, pending: 0, approved: 0, needsEdit: 0, rejected: 0 },
  );

  res.json(GetDashboardSummaryResponse.parse(summary));
});

export default router;
