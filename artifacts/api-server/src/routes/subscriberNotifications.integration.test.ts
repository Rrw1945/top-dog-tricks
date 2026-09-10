import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";

import { eq, inArray, sql } from "drizzle-orm";
import express from "express";
import {
  db,
  pool,
  spotlightNotificationsTable,
  submissionsTable,
  subscribersTable,
} from "@workspace/db";
import {
  claimSpotlightNotificationDelivery,
  listRecoverableSpotlightNotifications,
  SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS,
} from "./submissions";
import {
  claimReplacementSubscriberVerification,
  claimSubscriberVerification,
  createVerifySubscriberHandler,
  deliverSubscriberWelcome,
  findOrCreateSubscriberByEmail,
  recoverWelcomeEmails,
  requestSubscriberConfirmationReplacement,
  SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS,
  WELCOME_EMAIL_CLAIM_LEASE_MS,
} from "./engagement";
import { EmailDeliveryError } from "../lib/subscriberEmail";
import {
  getConfirmationCohort,
  readUnsubscribeToken,
} from "../lib/subscriberTokens";
import { normalizeSubscriberEmails } from "../../../../lib/db/scripts/normalize-subscriber-emails.mjs";

after(async () => {
  await pool.end();
});

test("valid confirmation links redirect with only privacy-safe outcome markers", async () => {
  const unique = crypto.randomUUID();
  const email = `confirmation-route-${unique}@example.com`;
  const verificationToken = `${getConfirmationCohort(new Date("2026-09-09T12:00:00Z"))}~verification-secret-${unique}`;
  const verificationTokenHash = createHash("sha256")
    .update(verificationToken)
    .digest("hex");
  const originalUnsubscribeHash = `unsubscribe-secret-${unique}`;
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: originalUnsubscribeHash,
      verificationTokenHash,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const welcomeDeliveries: Array<{ email: string; unsubscribeUrl: string }> = [];
  const app = express();
  app.get(
    "/api/subscribers/verify",
    createVerifySubscriberHandler(async (to, unsubscribeUrl) => {
      welcomeDeliveries.push({ email: to, unsubscribeUrl });
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/subscribers/verify?token=${encodeURIComponent(verificationToken)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 303);

    const location = response.headers.get("location");
    assert.ok(location);
    const redirect = new URL(location, "http://example.test");
    assert.equal(redirect.pathname, "/");
    assert.equal(redirect.hash, "#newsletter");
    assert.deepEqual(
      [...redirect.searchParams.entries()],
      [
        ["subscription", "confirmed"],
        ["confirmation_source", "initial"],
        ["confirmation_cohort", "2026-09-07"],
      ],
    );
    for (const privateValue of [
      email,
      verificationToken,
      verificationTokenHash,
      String(subscriber.id),
      originalUnsubscribeHash,
      welcomeDeliveries[0]?.unsubscribeUrl ?? "",
    ]) {
      assert.ok(privateValue);
      assert.equal(location.includes(privateValue), false);
    }

    assert.equal(welcomeDeliveries.length, 1);
    assert.equal(welcomeDeliveries[0]?.email, email);
    const [updated] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.ok(updated?.verifiedAt);
    assert.equal(updated?.verificationTokenHash, null);
    assert.equal(updated?.unsubscribedAt, null);
    assert.notEqual(updated?.unsubscribeTokenHash, originalUnsubscribeHash);

    for (const path of [
      "/api/subscribers/verify",
      `/api/subscribers/verify?token=${encodeURIComponent(`expired-${unique}`)}`,
    ]) {
      const errorResponse = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(errorResponse.status, 400);
      assert.equal(errorResponse.headers.get("content-type")?.includes("text/html"), true);
      assert.equal((await errorResponse.text()).includes(email), false);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("legacy confirmation links redirect with an explicit aggregate-only marker", async () => {
  const unique = crypto.randomUUID();
  const email = `legacy-confirmation-${unique}@example.com`;
  const verificationToken = `legacy-verification-${unique}`;
  const verificationTokenHash = createHash("sha256")
    .update(verificationToken)
    .digest("hex");
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: `unsubscribe-secret-${unique}`,
      verificationTokenHash,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const app = express();
  app.get(
    "/api/subscribers/verify",
    createVerifySubscriberHandler(async () => {}),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/subscribers/verify?token=${encodeURIComponent(verificationToken)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 303);

    const location = response.headers.get("location");
    assert.ok(location);
    const redirect = new URL(location, "http://example.test");
    assert.deepEqual(
      [...redirect.searchParams.entries()],
      [
        ["subscription", "confirmed"],
        ["confirmation_source", "initial"],
        ["confirmation_history", "legacy"],
      ],
    );
    assert.equal(redirect.searchParams.has("confirmation_cohort"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("concurrent confirmation requests claim one token and send one welcome email", async () => {
  const unique = crypto.randomUUID();
  const email = `concurrent-confirmation-${unique}@example.com`;
  const verificationToken = `concurrent-verification-${unique}`;
  const verificationTokenHash = createHash("sha256")
    .update(verificationToken)
    .digest("hex");
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: `unsubscribe-${unique}`,
      verificationTokenHash,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const welcomeDeliveries: string[] = [];
  const app = express();
  app.get(
    "/api/subscribers/verify",
    createVerifySubscriberHandler(async (to) => {
      welcomeDeliveries.push(to);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const verificationUrl =
    `http://127.0.0.1:${port}/api/subscribers/verify?token=${encodeURIComponent(verificationToken)}`;

  try {
    const responses = await Promise.all([
      fetch(verificationUrl, { redirect: "manual" }),
      fetch(verificationUrl, { redirect: "manual" }),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [303, 400],
    );
    assert.equal(welcomeDeliveries.length, 1);
    assert.equal(welcomeDeliveries[0], email);
    const expiredResponse = responses.find(
      (response) => response.status === 400,
    );
    assert.ok(expiredResponse);
    assert.match(await expiredResponse.text(), /That link has expired\./);

    const [updated] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.ok(updated?.verifiedAt);
    assert.equal(updated?.verificationTokenHash, null);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("temporary welcome failure stays verified and is recovered successfully", async () => {
  const unique = crypto.randomUUID();
  const email = `welcome-retry-${unique}@example.com`;
  const verificationToken = `welcome-retry-token-${unique}`;
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: unique,
      verificationTokenHash: createHash("sha256")
        .update(verificationToken)
        .digest("hex"),
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const attempts: Array<{
    unsubscribeUrl: string;
    idempotencyKey: string | undefined;
  }> = [];
  const app = express();
  app.get(
    "/api/subscribers/verify",
    createVerifySubscriberHandler(async (_to, unsubscribeUrl, idempotencyKey) => {
      attempts.push({ unsubscribeUrl, idempotencyKey });
      throw new Error("temporary provider outage");
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/subscribers/verify?token=${encodeURIComponent(verificationToken)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 303);

    const [failed] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.ok(failed?.verifiedAt);
    assert.equal(failed?.verificationTokenHash, null);
    assert.equal(failed?.welcomeEmailStatus, "failed");
    assert.equal(failed?.welcomeEmailAttemptCount, 1);
    assert.match(failed?.welcomeEmailLastError ?? "", /temporary provider outage/);

    const outcomes: string[] = [];
    await recoverWelcomeEmails(
      new URL(attempts[0]!.unsubscribeUrl).origin,
      (outcome) => outcomes.push(outcome),
      async (_to, unsubscribeUrl, idempotencyKey) => {
        attempts.push({ unsubscribeUrl, idempotencyKey });
      },
    );

    assert.deepEqual(outcomes, ["delivered"]);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.unsubscribeUrl, attempts[0]?.unsubscribeUrl);
    assert.equal(attempts[1]?.idempotencyKey, attempts[0]?.idempotencyKey);
    assert.equal(
      attempts[0]?.idempotencyKey,
      `subscriber-welcome-${subscriber.id}`,
    );

    const [delivered] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(delivered?.welcomeEmailStatus, "delivered");
    assert.ok(delivered?.welcomeEmailDeliveredAt);
    assert.equal(delivered?.welcomeEmailAttemptCount, 2);
    assert.equal(delivered?.welcomeEmailLastError, null);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("ambiguous welcome outcome retries with one idempotency identity", async () => {
  const unique = crypto.randomUUID();
  const email = `welcome-ambiguous-${unique}@example.com`;
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: unique,
      verifiedAt: new Date(),
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const attempts: Array<{
    unsubscribeUrl: string;
    idempotencyKey: string | undefined;
  }> = [];
  try {
    assert.equal(
      await deliverSubscriberWelcome(
        { id: subscriber.id, email },
        "https://example.com",
        async (_to, unsubscribeUrl, idempotencyKey) => {
          attempts.push({ unsubscribeUrl, idempotencyKey });
          throw new Error("provider accepted then connection closed");
        },
      ),
      "failed",
    );

    const outcomes: string[] = [];
    await recoverWelcomeEmails(
      "https://example.com",
      (outcome) => outcomes.push(outcome),
      async (_to, unsubscribeUrl, idempotencyKey) => {
        attempts.push({ unsubscribeUrl, idempotencyKey });
      },
    );

    assert.deepEqual(outcomes, ["delivered"]);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
  } finally {
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("welcome finalization failure after provider acceptance remains safely retryable", async () => {
  const unique = crypto.randomUUID();
  const email = `welcome-finalization-${unique}@example.com`;
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: unique,
      verifiedAt: new Date(),
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const attempts: Array<{
    unsubscribeUrl: string;
    idempotencyKey: string | undefined;
  }> = [];
  let finalizationAttempts = 0;
  try {
    assert.equal(
      await deliverSubscriberWelcome(
        { id: subscriber.id, email },
        "https://example.com",
        async (_to, unsubscribeUrl, idempotencyKey) => {
          attempts.push({ unsubscribeUrl, idempotencyKey });
        },
        async () => {
          finalizationAttempts += 1;
          throw new Error("database temporarily unavailable");
        },
      ),
      "failed",
    );
    assert.equal(finalizationAttempts, 1);
    assert.equal(attempts.length, 1);

    const firstAttempt = attempts[0]!;
    const unsubscribeToken = new URL(firstAttempt.unsubscribeUrl).searchParams.get(
      "token",
    );
    assert.ok(unsubscribeToken);
    assert.equal(readUnsubscribeToken(unsubscribeToken), subscriber.id);
    assert.equal(
      firstAttempt.idempotencyKey,
      `subscriber-welcome-${subscriber.id}`,
    );

    const [failed] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(failed?.welcomeEmailStatus, "failed");
    assert.equal(failed?.welcomeEmailAttemptCount, 1);
    assert.match(
      failed?.welcomeEmailLastError ?? "",
      /Provider accepted welcome email/,
    );

    const outcomes: string[] = [];
    await recoverWelcomeEmails(
      "https://example.com",
      (outcome) => outcomes.push(outcome),
      async (_to, unsubscribeUrl, idempotencyKey) => {
        attempts.push({ unsubscribeUrl, idempotencyKey });
      },
    );

    assert.deepEqual(outcomes, ["delivered"]);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], firstAttempt);

    const [delivered] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(delivered?.welcomeEmailStatus, "delivered");
    assert.equal(delivered?.welcomeEmailAttemptCount, 2);
    assert.equal(delivered?.welcomeEmailLastError, null);
  } finally {
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("concurrent welcome recovery sends one email for an expired claim", async () => {
  const unique = crypto.randomUUID();
  const email = `welcome-recovery-concurrent-${unique}@example.com`;
  const expiredClaimedAt = new Date(
    Date.now() - WELCOME_EMAIL_CLAIM_LEASE_MS - 1_000,
  );
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: unique,
      verifiedAt: new Date(),
      welcomeEmailStatus: "claimed",
      welcomeEmailClaimedAt: expiredClaimedAt,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const deliveries: Array<{
    email: string;
    idempotencyKey: string | undefined;
  }> = [];
  const outcomes: string[] = [];
  const sendWelcome = async (
    to: string,
    _unsubscribeUrl: string,
    idempotencyKey: string | undefined,
  ) => {
    deliveries.push({ email: to, idempotencyKey });
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const recover = () =>
    recoverWelcomeEmails(
      "https://example.com",
      (outcome, subscriberId) => {
        assert.equal(subscriberId, subscriber.id);
        outcomes.push(outcome);
      },
      sendWelcome,
    );

  try {
    await Promise.all([recover(), recover()]);

    assert.deepEqual(outcomes, ["delivered"]);
    assert.deepEqual(deliveries, [
      {
        email,
        idempotencyKey: `subscriber-welcome-${subscriber.id}`,
      },
    ]);

    const [recovered] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(recovered?.welcomeEmailStatus, "delivered");
    assert.equal(recovered?.welcomeEmailAttemptCount, 1);
    assert.ok(
      recovered?.welcomeEmailClaimedAt &&
        recovered.welcomeEmailClaimedAt.getTime() > expiredClaimedAt.getTime(),
    );

    const activeLeaseOutcomes: string[] = [];
    await recoverWelcomeEmails(
      "https://example.com",
      (outcome) => activeLeaseOutcomes.push(outcome),
      sendWelcome,
    );
    assert.deepEqual(activeLeaseOutcomes, []);
    assert.equal(deliveries.length, 1);
  } finally {
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("application clock skew cannot shorten a PostgreSQL welcome lease", async () => {
  const unique = crypto.randomUUID();
  const databaseNowResult = await pool.query<{ now: Date }>(
    "select CURRENT_TIMESTAMP as now",
  );
  const databaseNow = databaseNowResult.rows[0]!.now;
  const claimedAt = new Date(databaseNow.getTime() - 1_000);
  const fastApplicationClock = new Date(
    databaseNow.getTime() + WELCOME_EMAIL_CLAIM_LEASE_MS + 60_000,
  );
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email: `welcome-active-lease-${unique}@example.com`,
      unsubscribeTokenHash: unique,
      verifiedAt: databaseNow,
      welcomeEmailStatus: "claimed",
      welcomeEmailClaimedAt: claimedAt,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const deliveries: string[] = [];
  const outcomes: string[] = [];
  try {
    await recoverWelcomeEmails(
      "https://example.com",
      (outcome, subscriberId) => {
        assert.equal(subscriberId, subscriber.id);
        outcomes.push(outcome);
      },
      async (to) => {
        deliveries.push(to);
      },
      fastApplicationClock,
    );

    assert.deepEqual(outcomes, []);
    assert.deepEqual(deliveries, []);

    const [activeLease] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(activeLease?.welcomeEmailStatus, "claimed");
    assert.equal(activeLease?.welcomeEmailAttemptCount, 0);
    assert.equal(activeLease?.welcomeEmailClaimedAt?.getTime(), claimedAt.getTime());
  } finally {
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("application clock skew cannot hide an expired PostgreSQL welcome lease", async () => {
  const unique = crypto.randomUUID();
  const email = `welcome-expired-lease-${unique}@example.com`;
  const databaseNowResult = await pool.query<{ now: Date }>(
    "select CURRENT_TIMESTAMP as now",
  );
  const databaseNow = databaseNowResult.rows[0]!.now;
  const expiredClaimedAt = new Date(
    databaseNow.getTime() - WELCOME_EMAIL_CLAIM_LEASE_MS - 1_000,
  );
  const slowApplicationClock = new Date(
    databaseNow.getTime() - WELCOME_EMAIL_CLAIM_LEASE_MS - 60_000,
  );
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: unique,
      verifiedAt: databaseNow,
      welcomeEmailStatus: "claimed",
      welcomeEmailClaimedAt: expiredClaimedAt,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const deliveries: string[] = [];
  const outcomes: string[] = [];
  try {
    await recoverWelcomeEmails(
      "https://example.com",
      (outcome, subscriberId) => {
        assert.equal(subscriberId, subscriber.id);
        outcomes.push(outcome);
      },
      async (to) => {
        deliveries.push(to);
      },
      slowApplicationClock,
    );

    assert.deepEqual(outcomes, ["delivered"]);
    assert.deepEqual(deliveries, [email]);

    const [recovered] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(recovered?.welcomeEmailStatus, "delivered");
    assert.equal(recovered?.welcomeEmailAttemptCount, 1);
    assert.ok(
      recovered?.welcomeEmailClaimedAt &&
        recovered.welcomeEmailClaimedAt.getTime() > expiredClaimedAt.getTime(),
    );
  } finally {
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("definite welcome rejection is persisted and reported as permanent", async () => {
  const unique = crypto.randomUUID();
  const email = `welcome-permanent-${unique}@example.com`;
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: unique,
      verifiedAt: new Date(),
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  try {
    assert.equal(
      await deliverSubscriberWelcome(
        { id: subscriber.id, email },
        "https://example.com",
        async () => {
          throw new EmailDeliveryError("Resend request failed (400)", false);
        },
      ),
      "permanently_failed",
    );
    const [failed] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(failed?.welcomeEmailStatus, "permanently_failed");
    assert.ok(failed?.welcomeEmailFailedAt);
    assert.match(failed?.welcomeEmailLastError ?? "", /400/);
  } finally {
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("PostgreSQL allows exactly one worker to claim a first-time notification", async () => {
  const unique = crypto.randomUUID();
  const [submission] = await db
    .insert(submissionsTable)
    .values({
      ownerName: "First notification concurrency test",
      email: `owner-${unique}@example.com`,
      phone: "test",
      dogName: "First",
      trickName: "Concurrent first claim",
      trickDescription: "Database integration fixture",
      videoObjectPath: `test/${unique}/video`,
      videoFileName: "video.mp4",
      videoContentType: "video/mp4",
      signatureObjectPath: `test/${unique}/signature`,
    })
    .returning({ id: submissionsTable.id });
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email: `subscriber-${unique}@example.com`,
      unsubscribeTokenHash: unique,
      verifiedAt: new Date(),
    })
    .returning({ id: subscribersTable.id });

  assert.ok(submission);
  assert.ok(subscriber);

  try {
    const claims = await Promise.all([
      claimSpotlightNotificationDelivery(submission.id, subscriber.id),
      claimSpotlightNotificationDelivery(submission.id, subscriber.id),
    ]);

    const successfulClaims = claims.filter((id) => id !== null);
    assert.equal(successfulClaims.length, 1);
    assert.equal(claims.filter((id) => id === null).length, 1);

    const notifications = await db
      .select()
      .from(spotlightNotificationsTable)
      .where(eq(spotlightNotificationsTable.submissionId, submission.id));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.id, successfulClaims[0]);
    assert.equal(notifications[0]?.status, "claimed");
    assert.equal(notifications[0]?.attemptCount, 1);
  } finally {
    await db
      .delete(submissionsTable)
      .where(eq(submissionsTable.id, submission.id));
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("differently-cased subscriber creation allows at most one spotlight delivery per inbox", async () => {
  const unique = crypto.randomUUID();
  const email = `Case-${unique}@Example.com`;
  const [submission] = await db
    .insert(submissionsTable)
    .values({
      ownerName: "Case-insensitive subscriber test",
      email: `owner-case-${unique}@example.com`,
      phone: "test",
      dogName: "Casey",
      trickName: "Canonical inbox",
      trickDescription: "Database integration fixture",
      videoObjectPath: `test/${unique}/video`,
      videoFileName: "video.mp4",
      videoContentType: "video/mp4",
      signatureObjectPath: `test/${unique}/signature`,
    })
    .returning({ id: submissionsTable.id });
  assert.ok(submission);

  try {
    const subscribers = await Promise.all([
      findOrCreateSubscriberByEmail(email),
      findOrCreateSubscriberByEmail(email.toLowerCase()),
      findOrCreateSubscriberByEmail(email.toUpperCase()),
    ]);
    assert.equal(new Set(subscribers.map((subscriber) => subscriber.id)).size, 1);

    const canonicalRows = await db
      .select({ id: subscribersTable.id })
      .from(subscribersTable)
      .where(
        sql`lower(trim(${subscribersTable.email})) = ${email.trim().toLowerCase()}`,
      );
    assert.equal(canonicalRows.length, 1);

    const claims = await Promise.all(
      subscribers.map((subscriber) =>
        claimSpotlightNotificationDelivery(submission.id, subscriber.id),
      ),
    );
    assert.equal(claims.filter((id) => id !== null).length, 1);

    const notifications = await db
      .select({ id: spotlightNotificationsTable.id })
      .from(spotlightNotificationsTable)
      .where(eq(spotlightNotificationsTable.submissionId, submission.id));
    assert.equal(notifications.length, 1);
  } finally {
    await db
      .delete(submissionsTable)
      .where(eq(submissionsTable.id, submission.id));
    await db
      .delete(subscribersTable)
      .where(
        sql`lower(trim(${subscribersTable.email})) = ${email.trim().toLowerCase()}`,
      );
  }
});

test("simultaneous differently-cased signups share one actionable confirmation attempt", async () => {
  const unique = crypto.randomUUID();
  const email = `Confirm-${unique}@Example.com`;

  try {
    const subscribers = await Promise.all([
      findOrCreateSubscriberByEmail(email),
      findOrCreateSubscriberByEmail(email.toLowerCase()),
      findOrCreateSubscriberByEmail(email.toUpperCase()),
    ]);
    assert.equal(new Set(subscribers.map((subscriber) => subscriber.id)).size, 1);

    const attempts = await Promise.all([
      claimSubscriberVerification(subscribers[0]!.id, email),
      claimSubscriberVerification(subscribers[1]!.id, email.toLowerCase()),
      claimSubscriberVerification(subscribers[2]!.id, email.toUpperCase()),
    ]);
    const claimedTokens = attempts.filter(
      (attempt): attempt is string => attempt !== null,
    );
    assert.equal(claimedTokens.length, 1);

    const [subscriber] = await db
      .select({
        email: subscribersTable.email,
        verificationTokenHash: subscribersTable.verificationTokenHash,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscribers[0]!.id));
    assert.equal(subscriber?.email, email.toLowerCase());
    assert.equal(
      subscriber?.verificationTokenHash,
      createHash("sha256").update(claimedTokens[0]!).digest("hex"),
    );
  } finally {
    await db
      .delete(subscribersTable)
      .where(
        sql`lower(trim(${subscribersTable.email})) = ${email.trim().toLowerCase()}`,
      );
  }
});

test("replacement confirmation waits for the cooldown and preserves the active token", async () => {
  const unique = crypto.randomUUID();
  const email = `replacement-timing-${unique}@example.com`;
  const originalTokenHash = createHash("sha256")
    .update(`original-${unique}`)
    .digest("hex");
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: unique,
      verificationTokenHash: originalTokenHash,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  try {
    assert.equal(
      await claimReplacementSubscriberVerification(subscriber.id, email),
      null,
    );

    const [unchanged] = await db
      .select({ verificationTokenHash: subscribersTable.verificationTokenHash })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(unchanged?.verificationTokenHash, originalTokenHash);

    await db
      .update(subscribersTable)
      .set({
        updatedAt: new Date(
          Date.now() - SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS - 1_000,
        ),
      })
      .where(eq(subscribersTable.id, subscriber.id));

    const claim = await claimReplacementSubscriberVerification(
      subscriber.id,
      email,
    );
    assert.ok(claim?.token);
  } finally {
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("concurrent differently-cased replacement requests rotate one pending token", async () => {
  const unique = crypto.randomUUID();
  const email = `Replacement-${unique}@Example.com`;
  const originalTokenHash = createHash("sha256")
    .update(`original-${unique}`)
    .digest("hex");
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email: email.toLowerCase(),
      unsubscribeTokenHash: unique,
      verificationTokenHash: originalTokenHash,
      updatedAt: new Date(
        Date.now() - SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS - 1_000,
      ),
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  try {
    const attempts = await Promise.all([
      claimReplacementSubscriberVerification(subscriber.id, email),
      claimReplacementSubscriberVerification(subscriber.id, email.toLowerCase()),
      claimReplacementSubscriberVerification(subscriber.id, email.toUpperCase()),
    ]);
    const claimedTokens = attempts.filter(
      (attempt): attempt is NonNullable<typeof attempt> => attempt !== null,
    );
    assert.equal(claimedTokens.length, 1);

    const [updated] = await db
      .select({
        email: subscribersTable.email,
        verificationTokenHash: subscribersTable.verificationTokenHash,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(updated?.email, email.toLowerCase());
    assert.equal(
      updated?.verificationTokenHash,
      createHash("sha256").update(claimedTokens[0]!.token).digest("hex"),
    );
    assert.notEqual(updated?.verificationTokenHash, originalTokenHash);
  } finally {
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("ambiguous replacement delivery retries the same actionable link and idempotency key", async () => {
  const unique = crypto.randomUUID();
  const email = `Replacement-Failure-${unique}@Example.com`;
  const previousToken = `previous-${unique}`;
  const previousTokenHash = createHash("sha256")
    .update(previousToken)
    .digest("hex");
  const previousUpdatedAt = new Date(
    Date.now() - SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS - 5_000,
  );
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email: email.toLowerCase(),
      unsubscribeTokenHash: unique,
      verificationTokenHash: previousTokenHash,
      updatedAt: previousUpdatedAt,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  try {
    const deliveries: Array<{
      email: string;
      verifyUrl: string;
      idempotencyKey: string | undefined;
    }> = [];
    await assert.rejects(
      requestSubscriberConfirmationReplacement(
        email.toUpperCase(),
        "example.com",
        async (to, verifyUrl, idempotencyKey) => {
          deliveries.push({ email: to, verifyUrl, idempotencyKey });
          throw new Error("ambiguous provider failure");
        },
      ),
      /ambiguous provider failure/,
    );

    const [retainedAttempt] = await db
      .select({
        verificationTokenHash: subscribersTable.verificationTokenHash,
        replacementVerificationAttemptId:
          subscribersTable.replacementVerificationAttemptId,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.notEqual(retainedAttempt?.verificationTokenHash, previousTokenHash);
    assert.ok(retainedAttempt?.replacementVerificationAttemptId);

    assert.equal(
      await requestSubscriberConfirmationReplacement(
        email,
        "example.com",
        async (to, verifyUrl, idempotencyKey) => {
          deliveries.push({ email: to, verifyUrl, idempotencyKey });
        },
      ),
      true,
    );
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0]?.email, email.toLowerCase());
    assert.equal(deliveries[1]?.email, email.toLowerCase());
    assert.equal(deliveries[1]?.verifyUrl, deliveries[0]?.verifyUrl);
    assert.equal(
      deliveries[1]?.idempotencyKey,
      deliveries[0]?.idempotencyKey,
    );
    assert.match(
      deliveries[0]?.idempotencyKey ?? "",
      new RegExp(`^subscriber-confirmation-replacement-${subscriber.id}-`),
    );

    const [finalizedAttempt] = await db
      .select({
        replacementVerificationAttemptId:
          subscribersTable.replacementVerificationAttemptId,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(finalizedAttempt?.replacementVerificationAttemptId, null);
    assert.equal(
      await requestSubscriberConfirmationReplacement(
        email,
        "example.com",
        async (to, verifyUrl, idempotencyKey) => {
          deliveries.push({ email: to, verifyUrl, idempotencyKey });
        },
      ),
      false,
    );
    assert.equal(deliveries.length, 2);

    await db
      .update(subscribersTable)
      .set({
        updatedAt: new Date(
          Date.now() - SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS - 1_000,
        ),
      })
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(
      await requestSubscriberConfirmationReplacement(
        email,
        "example.com",
        async (to, verifyUrl, idempotencyKey) => {
          deliveries.push({ email: to, verifyUrl, idempotencyKey });
        },
      ),
      true,
    );
    assert.equal(deliveries.length, 3);
    assert.notEqual(deliveries[2]?.verifyUrl, deliveries[1]?.verifyUrl);
    assert.notEqual(
      deliveries[2]?.idempotencyKey,
      deliveries[1]?.idempotencyKey,
    );

    const replacementToken = new URL(deliveries[2]!.verifyUrl).searchParams.get(
      "token",
    );
    assert.ok(replacementToken);
    const [replaced] = await db
      .select({
        verificationTokenHash: subscribersTable.verificationTokenHash,
        unsubscribeTokenHash: subscribersTable.unsubscribeTokenHash,
        verifiedAt: subscribersTable.verifiedAt,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(
      replaced?.verificationTokenHash,
      createHash("sha256").update(replacementToken).digest("hex"),
    );
    assert.notEqual(replaced?.verificationTokenHash, previousTokenHash);
    assert.equal(replaced?.unsubscribeTokenHash, unique);
    assert.equal(replaced?.verifiedAt, null);
  } finally {
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("replacement requests do not disclose or email unknown and verified addresses", async () => {
  const unique = crypto.randomUUID();
  const verifiedEmail = `verified-replacement-${unique}@example.com`;
  const [verifiedSubscriber] = await db
    .insert(subscribersTable)
    .values({
      email: verifiedEmail,
      unsubscribeTokenHash: unique,
      verificationTokenHash: createHash("sha256")
        .update(`stale-${unique}`)
        .digest("hex"),
      verifiedAt: new Date(),
      updatedAt: new Date(
        Date.now() - SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS - 1_000,
      ),
    })
    .returning({ id: subscribersTable.id });
  assert.ok(verifiedSubscriber);
  let deliveryCount = 0;
  const recordDelivery = async () => {
    deliveryCount += 1;
  };

  try {
    assert.equal(
      await requestSubscriberConfirmationReplacement(
        `unknown-${unique}@example.com`,
        "example.com",
        recordDelivery,
      ),
      false,
    );
    assert.equal(
      await requestSubscriberConfirmationReplacement(
        verifiedEmail.toUpperCase(),
        "example.com",
        recordDelivery,
      ),
      false,
    );
    assert.equal(deliveryCount, 0);
  } finally {
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, verifiedSubscriber.id));
  }
});

test("legacy case-variant subscribers are consolidated without duplicate spotlight history", async () => {
  const unique = crypto.randomUUID();
  const email = `Legacy-${unique}@Example.com`;
  const client = await pool.connect();
  let submissionId: number | undefined;

  try {
    await client.query("drop index subscribers_email_idx");
    await client.query(
      "create unique index subscribers_email_idx on subscribers (email)",
    );

    const submissionResult = await client.query<{ id: number }>(
      `insert into submissions (
        owner_name, email, phone, dog_name, trick_name, trick_description,
        video_object_path, video_file_name, video_content_type, signature_object_path
      ) values ($1, $2, 'test', 'Legacy', 'Canonical history',
        'Database integration fixture', $3, 'video.mp4', 'video/mp4', $4)
      returning id`,
      [
        "Legacy subscriber migration test",
        `owner-legacy-${unique}@example.com`,
        `test/${unique}/video`,
        `test/${unique}/signature`,
      ],
    );
    submissionId = submissionResult.rows[0]!.id;

    const subscriberResult = await client.query<{ id: number }>(
      `insert into subscribers (
        email, unsubscribe_token_hash, verified_at, unsubscribed_at
      ) values
        ($1, $2, now(), null),
        ($3, $4, now(), now())
      returning id`,
      [email, `${unique}-one`, email.toLowerCase(), `${unique}-two`],
    );
    const [firstSubscriber, secondSubscriber] = subscriberResult.rows;
    await client.query(
      `insert into spotlight_notifications (
        submission_id, subscriber_id, status, delivered_at, sent_at
      ) values
        ($1, $2, 'failed', null, null),
        ($1, $3, 'delivered', now(), now())`,
      [submissionId, firstSubscriber!.id, secondSubscriber!.id],
    );

    await normalizeSubscriberEmails(client);
    await client.query("drop index subscribers_email_idx");
    await client.query(
      "create unique index subscribers_email_idx on subscribers (lower(trim(email)))",
    );

    const canonicalSubscribers = await client.query<{
      id: number;
      email: string;
      unsubscribed_at: Date | null;
    }>(
      `select id, email, unsubscribed_at
       from subscribers
       where lower(trim(email)) = lower(trim($1))`,
      [email],
    );
    assert.equal(canonicalSubscribers.rowCount, 1);
    assert.equal(canonicalSubscribers.rows[0]!.email, email.toLowerCase());
    assert.equal(canonicalSubscribers.rows[0]!.unsubscribed_at, null);

    const notifications = await client.query<{
      subscriber_id: number;
      status: string;
    }>(
      `select subscriber_id, status
       from spotlight_notifications
       where submission_id = $1`,
      [submissionId],
    );
    assert.deepEqual(notifications.rows, [
      {
        subscriber_id: canonicalSubscribers.rows[0]!.id,
        status: "delivered",
      },
    ]);
  } finally {
    if (submissionId !== undefined) {
      await client.query("delete from submissions where id = $1", [submissionId]);
    }
    await client.query(
      "delete from subscribers where lower(trim(email)) = lower(trim($1))",
      [email],
    );
    await client.query("drop index if exists subscribers_email_idx");
    await client.query(
      "create unique index subscribers_email_idx on subscribers (lower(trim(email)))",
    );
    client.release();
  }
});

test("PostgreSQL allows exactly one worker to claim each notification retry", async () => {
  const unique = crypto.randomUUID();
  const [submission] = await db
    .insert(submissionsTable)
    .values({
      ownerName: "Notification concurrency test",
      email: `owner-${unique}@example.com`,
      phone: "test",
      dogName: "Retry",
      trickName: "Concurrent claim",
      trickDescription: "Database integration fixture",
      videoObjectPath: `test/${unique}/video`,
      videoFileName: "video.mp4",
      videoContentType: "video/mp4",
      signatureObjectPath: `test/${unique}/signature`,
    })
    .returning({ id: submissionsTable.id });
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email: `subscriber-${unique}@example.com`,
      unsubscribeTokenHash: unique,
      verifiedAt: new Date(),
    })
    .returning({ id: subscribersTable.id });

  assert.ok(submission);
  assert.ok(subscriber);

  try {
    const [notification] = await db
      .insert(spotlightNotificationsTable)
      .values({
        submissionId: submission.id,
        subscriberId: subscriber.id,
        status: "failed",
        failedAt: new Date(),
        lastError: "temporary provider failure",
      })
      .returning({ id: spotlightNotificationsTable.id });
    assert.ok(notification);

    const claimRetryConcurrently = () =>
      Promise.all([
        claimSpotlightNotificationDelivery(submission.id, subscriber.id),
        claimSpotlightNotificationDelivery(submission.id, subscriber.id),
      ]);

    const firstRetry = await claimRetryConcurrently();
    assert.equal(firstRetry.filter((id) => id === notification.id).length, 1);
    assert.equal(firstRetry.filter((id) => id === null).length, 1);

    const [firstClaimedRow] = await db
      .select()
      .from(spotlightNotificationsTable)
      .where(eq(spotlightNotificationsTable.id, notification.id));
    assert.equal(firstClaimedRow?.status, "claimed");
    assert.equal(firstClaimedRow?.attemptCount, 2);

    await db
      .update(spotlightNotificationsTable)
      .set({ status: "delivered", deliveredAt: new Date() })
      .where(eq(spotlightNotificationsTable.id, notification.id));
    assert.deepEqual(await claimRetryConcurrently(), [null, null]);

    await db
      .update(spotlightNotificationsTable)
      .set({ status: "failed", failedAt: new Date() })
      .where(eq(spotlightNotificationsTable.id, notification.id));
    const secondRetry = await claimRetryConcurrently();
    assert.equal(secondRetry.filter((id) => id === notification.id).length, 1);
    assert.equal(secondRetry.filter((id) => id === null).length, 1);

    const [secondClaimedRow] = await db
      .select()
      .from(spotlightNotificationsTable)
      .where(eq(spotlightNotificationsTable.id, notification.id));
    assert.equal(secondClaimedRow?.status, "claimed");
    assert.equal(secondClaimedRow?.attemptCount, 3);
  } finally {
    await db
      .delete(submissionsTable)
      .where(eq(submissionsTable.id, submission.id));
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("PostgreSQL allows exactly one worker to recover an expired notification claim", async () => {
  const unique = crypto.randomUUID();
  const [submission] = await db
    .insert(submissionsTable)
    .values({
      ownerName: "Expired notification claim test",
      email: `owner-expired-${unique}@example.com`,
      phone: "test",
      dogName: "Lease",
      trickName: "Concurrent recovery",
      trickDescription: "Database integration fixture",
      videoObjectPath: `test/${unique}/video`,
      videoFileName: "video.mp4",
      videoContentType: "video/mp4",
      signatureObjectPath: `test/${unique}/signature`,
    })
    .returning({ id: submissionsTable.id });
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email: `subscriber-expired-${unique}@example.com`,
      unsubscribeTokenHash: unique,
      verifiedAt: new Date(),
    })
    .returning({ id: subscribersTable.id });

  assert.ok(submission);
  assert.ok(subscriber);

  try {
    const expiredClaimedAt = new Date(
      Date.now() - SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS - 1_000,
    );
    const [notification] = await db
      .insert(spotlightNotificationsTable)
      .values({
        submissionId: submission.id,
        subscriberId: subscriber.id,
        status: "claimed",
        claimedAt: expiredClaimedAt,
      })
      .returning({ id: spotlightNotificationsTable.id });
    assert.ok(notification);

    const recoveryClaims = await Promise.all([
      claimSpotlightNotificationDelivery(submission.id, subscriber.id),
      claimSpotlightNotificationDelivery(submission.id, subscriber.id),
    ]);

    assert.equal(
      recoveryClaims.filter((id) => id === notification.id).length,
      1,
    );
    assert.equal(recoveryClaims.filter((id) => id === null).length, 1);

    const [recoveredRow] = await db
      .select()
      .from(spotlightNotificationsTable)
      .where(eq(spotlightNotificationsTable.id, notification.id));
    assert.equal(recoveredRow?.status, "claimed");
    assert.equal(recoveredRow?.attemptCount, 2);
    assert.ok(
      recoveredRow?.claimedAt &&
        recoveredRow.claimedAt.getTime() > expiredClaimedAt.getTime(),
    );

    const activeLeaseClaims = await Promise.all([
      claimSpotlightNotificationDelivery(submission.id, subscriber.id),
      claimSpotlightNotificationDelivery(submission.id, subscriber.id),
    ]);
    assert.deepEqual(activeLeaseClaims, [null, null]);
  } finally {
    await db
      .delete(submissionsTable)
      .where(eq(submissionsTable.id, submission.id));
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("application clock skew cannot shorten a PostgreSQL notification lease", async () => {
  const unique = crypto.randomUUID();
  const databaseNowResult = await pool.query<{ now: Date }>(
    "select CURRENT_TIMESTAMP as now",
  );
  const databaseNow = databaseNowResult.rows[0]!.now;
  const claimedAt = new Date(databaseNow.getTime() - 1_000);
  const fastApplicationClock = new Date(
    databaseNow.getTime() + SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS + 60_000,
  );
  const [submission] = await db
    .insert(submissionsTable)
    .values({
      ownerName: "Notification lease cutoff test",
      email: `owner-cutoff-${unique}@example.com`,
      phone: "test",
      dogName: "Boundary",
      trickName: "Exact lease cutoff",
      trickDescription: "Database integration fixture",
      videoObjectPath: `test/${unique}/video`,
      videoFileName: "video.mp4",
      videoContentType: "video/mp4",
      signatureObjectPath: `test/${unique}/signature`,
    })
    .returning({ id: submissionsTable.id });
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email: `subscriber-cutoff-${unique}@example.com`,
      unsubscribeTokenHash: unique,
      verifiedAt: databaseNow,
    })
    .returning({ id: subscribersTable.id });

  assert.ok(submission);
  assert.ok(subscriber);

  try {
    const [notification] = await db
      .insert(spotlightNotificationsTable)
      .values({
        submissionId: submission.id,
        subscriberId: subscriber.id,
        status: "claimed",
        claimedAt,
      })
      .returning({ id: spotlightNotificationsTable.id });
    assert.ok(notification);

    const skewedClaims = await Promise.all([
      claimSpotlightNotificationDelivery(
        submission.id,
        subscriber.id,
        fastApplicationClock,
      ),
      claimSpotlightNotificationDelivery(
        submission.id,
        subscriber.id,
        fastApplicationClock,
      ),
    ]);
    assert.deepEqual(skewedClaims, [null, null]);

    const [claimedRow] = await db
      .select()
      .from(spotlightNotificationsTable)
      .where(eq(spotlightNotificationsTable.id, notification.id));
    assert.equal(claimedRow?.status, "claimed");
    assert.equal(claimedRow?.attemptCount, 1);
    assert.equal(claimedRow?.claimedAt?.getTime(), claimedAt.getTime());

    const candidates = (
      await listRecoverableSpotlightNotifications(fastApplicationClock)
    ).filter((candidate) => candidate.submissionId === submission.id);
    assert.deepEqual(candidates, []);
  } finally {
    await db
      .delete(submissionsTable)
      .where(eq(submissionsTable.id, submission.id));
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("recovery discovery includes only failed and expired eligible claims", async () => {
  const unique = crypto.randomUUID();
  const now = new Date();
  const [submission] = await db
    .insert(submissionsTable)
    .values({
      ownerName: "Notification recovery test",
      email: `owner-recovery-${unique}@example.com`,
      phone: "test",
      dogName: "Recovery",
      trickName: "Scheduled retry",
      trickDescription: "Database integration fixture",
      videoObjectPath: `test/${unique}/video`,
      videoFileName: "video.mp4",
      videoContentType: "video/mp4",
      signatureObjectPath: `test/${unique}/signature`,
      status: "approved",
      processingStatus: "completed",
    })
    .returning({ id: submissionsTable.id });
  assert.ok(submission);

  const statuses = ["failed", "claimed", "claimed", "delivered"] as const;
  const subscribers = await db
    .insert(subscribersTable)
    .values(
      statuses.map((status, index) => ({
        email: `recovery-${index}-${unique}@example.com`,
        unsubscribeTokenHash: `${unique}-${index}`,
        verifiedAt: new Date(),
      })),
    )
    .returning({ id: subscribersTable.id });

  try {
    await db.insert(spotlightNotificationsTable).values(
      statuses.map((status, index) => ({
        submissionId: submission.id,
        subscriberId: subscribers[index]!.id,
        status,
        claimedAt:
          index === 1
            ? new Date(
                now.getTime() - SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS - 1,
              )
            : now,
        deliveredAt: status === "delivered" ? now : null,
        failedAt: status === "failed" ? now : null,
      })),
    );

    const candidates = (
      await listRecoverableSpotlightNotifications(now)
    ).filter((candidate) => candidate.submissionId === submission.id);

    assert.deepEqual(
      candidates.map((candidate) => candidate.subscriberId).sort(),
      [subscribers[0]!.id, subscribers[1]!.id].sort(),
    );
  } finally {
    await db
      .delete(submissionsTable)
      .where(eq(submissionsTable.id, submission.id));
    await db
      .delete(subscribersTable)
      .where(
        inArray(
          subscribersTable.id,
          subscribers.map((subscriber) => subscriber.id),
        ),
      );
  }
});