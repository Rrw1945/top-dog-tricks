import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, mock, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import { eq, inArray, sql } from "drizzle-orm";
import express, { type ErrorRequestHandler } from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import pretty from "pino-pretty";
import { ReplitConnectors } from "@replit/connectors-sdk";
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
  WELCOME_EMAIL_RECOVERY_BATCH_SIZE,
  WELCOME_EMAIL_RECOVERY_REPEATED_FAILURE_ATTEMPTS,
  classifyWelcomeEmailBacklog,
  getWelcomeEmailAdminBacklog,
  listWelcomeEmailAdminRecords,
} from "./engagement";
import adminRouter from "./admin";
import engagementRouter from "./engagement";
import { EmailDeliveryError } from "../lib/subscriberEmail";
import { requestLogSerializers } from "../lib/requestLogSerializers";
import {
  createUnsubscribeToken,
  getConfirmationCohort,
  readConfirmationTokenMetadata,
  readUnsubscribeToken,
} from "../lib/subscriberTokens";
import { normalizeSubscriberEmails } from "../../../../lib/db/scripts/normalize-subscriber-emails.mjs";

// Fixture-only signing material, never a workspace or production credential.
process.env.SESSION_SECRET = "subscriber-notifications-test-only-signing-key";
const originalFetch = globalThis.fetch;
let externalFetchAttempts = 0;
const fetchGuard = mock.method(globalThis, "fetch", (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    externalFetchAttempts++;
    throw new Error("Subscriber fixtures must not make external HTTP requests");
  }
  return originalFetch(input, init);
});

after(async () => {
  fetchGuard.mock.restore();
  await pool.end();
  assert.equal(externalFetchAttempts, 0, "Subscriber tests attempted external HTTP");
});

class CapturedLogStream extends Writable {
  output = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += chunk.toString();
    callback();
  }
}

test("subscriber token URLs are redacted from structured and pretty request logs", async () => {
  const unique = crypto.randomUUID();
  const confirmationToken = `confirmation-log-secret-${unique}`;
  const unsubscribeToken = `unsubscribe-log-secret-${unique}`;
  const structuredLogs = new CapturedLogStream();
  const prettyLogs = new CapturedLogStream();
  const logger = pino(
    { level: "info" },
    pino.multistream([
      { stream: structuredLogs },
      {
        stream: pretty({
          colorize: false,
          destination: prettyLogs,
        }),
      },
    ]),
  );

  const serverApp = express();
  serverApp.use(
    pinoHttp({
      logger,
      serializers: requestLogSerializers,
    }),
  );
  serverApp.use("/api", engagementRouter);
  const server = serverApp.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const requests = [
      {
        path: "/api/subscribers/verify",
        token: confirmationToken,
      },
      {
        path: "/api/subscribers/unsubscribe",
        token: unsubscribeToken,
      },
    ];
    for (const { path, token } of requests) {
      const response = await fetch(
        `${baseUrl}${path}?token=${encodeURIComponent(token)}`,
      );
      assert.equal(response.status, 400);
      await response.arrayBuffer();
    }

    const records = structuredLogs.output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        req: { method: string; url: string };
        res: { statusCode: number };
        responseTime: number;
      });
    assert.equal(records.length, requests.length);
    for (const [index, record] of records.entries()) {
      assert.equal(record.req.method, "GET");
      assert.equal(record.req.url, requests[index]?.path);
      assert.equal(record.res.statusCode, 400);
      assert.equal(typeof record.responseTime, "number");
    }

    for (const token of [confirmationToken, unsubscribeToken]) {
      assert.equal(structuredLogs.output.includes(token), false);
      assert.equal(prettyLogs.output.includes(token), false);
    }
    for (const { path } of requests) {
      assert.equal(prettyLogs.output.includes(path), true);
      assert.equal(prettyLogs.output.includes("400"), true);
      assert.equal(prettyLogs.output.includes("responseTime"), true);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    logger.flush();
  }
});

test("request and confirmation links keep one safe cohort across a Monday UTC boundary", async () => {
  const unique = crypto.randomUUID();
  const initialEmail = `boundary-initial-${unique}@example.com`;
  const replacementEmail = `boundary-replacement-${unique}@example.com`;
  const sundayBoundary = new Date("2026-09-06T23:59:59.999Z");
  const mondayBoundary = new Date("2026-09-07T00:00:00.000Z");
  const expectedCohort = "2026-08-31";
  const confirmationDeliveries: Array<{
    email: string;
    verifyUrl: string;
  }> = [];
  let advanceAfterConfirmation: Date | null = null;
  const connectorMock = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async (
      _connectorName: string,
      _path: string,
      options?: { body?: unknown },
    ) => {
      const body = options?.body as
        { html?: string; to?: string[] } | undefined;
      const confirmationLink = body?.html?.match(
        /href="([^"]*\/api\/subscribers\/verify\?token=([^"]+))"/,
      );
      if (confirmationLink) {
        confirmationDeliveries.push({
          email: body?.to?.[0] ?? "",
          verifyUrl: confirmationLink[1]!,
        });
        if (advanceAfterConfirmation) {
          mock.timers.setTime(advanceAfterConfirmation.getTime());
          advanceAfterConfirmation = null;
        }
      }
      return new Response("", { status: 200 });
    },
  );
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use("/api", engagementRouter);
  const server = serverApp.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const subscriberIds: number[] = [];

  mock.timers.enable({ apis: ["Date"], now: sundayBoundary });
  try {
    advanceAfterConfirmation = mondayBoundary;
    const initialResponse = await fetch(`${baseUrl}/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: initialEmail, consent: true }),
    });
    assert.equal(initialResponse.status, 202);
    const initialPayload = (await initialResponse.json()) as {
      message: string;
      cohort: string;
    };
    assert.deepEqual(Object.keys(initialPayload).sort(), ["cohort", "message"]);
    assert.equal(initialPayload.cohort, expectedCohort);

    const [initialSubscriber] = await db
      .select({ id: subscribersTable.id })
      .from(subscribersTable)
      .where(eq(subscribersTable.email, initialEmail));
    assert.ok(initialSubscriber);
    subscriberIds.push(initialSubscriber.id);
    const initialDelivery = confirmationDeliveries[0];
    assert.equal(initialDelivery?.email, initialEmail);
    assert.ok(initialDelivery?.verifyUrl);
    const initialToken = new URL(initialDelivery!.verifyUrl).searchParams.get(
      "token",
    );
    assert.ok(initialToken);
    assert.deepEqual(readConfirmationTokenMetadata(initialToken), {
      source: "initial",
      cohort: initialPayload.cohort,
      history: "native",
    });
    for (const privateValue of [initialEmail, initialToken]) {
      assert.equal(
        JSON.stringify(initialPayload).includes(privateValue),
        false,
      );
    }

    const initialConfirmation = await fetch(
      `${baseUrl}/api/subscribers/verify?token=${encodeURIComponent(initialToken)}`,
      { redirect: "manual" },
    );
    assert.equal(initialConfirmation.status, 303);
    const initialLocation = initialConfirmation.headers.get("location");
    assert.ok(initialLocation);
    const initialRedirect = new URL(initialLocation, baseUrl);
    assert.deepEqual(
      [...initialRedirect.searchParams.entries()],
      [
        ["subscription", "confirmed"],
        ["confirmation_source", "initial"],
        ["confirmation_cohort", expectedCohort],
      ],
    );
    assert.equal(initialLocation.includes(initialToken), false);
    assert.equal(initialLocation.includes(initialEmail), false);

    mock.timers.setTime(sundayBoundary.getTime());
    const replacementToken = `pending-${unique}`;
    const [replacementSubscriber] = await db
      .insert(subscribersTable)
      .values({
        email: replacementEmail,
        unsubscribeTokenHash: `unsubscribe-${unique}`,
        verificationTokenHash: createHash("sha256")
          .update(replacementToken)
          .digest("hex"),
        updatedAt: new Date(
          sundayBoundary.getTime() -
            SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS -
            1_000,
        ),
      })
      .returning({ id: subscribersTable.id });
    assert.ok(replacementSubscriber);
    subscriberIds.push(replacementSubscriber.id);
    assert.deepEqual(readConfirmationTokenMetadata(replacementToken), {
      source: "initial",
      cohort: null,
      history: "legacy",
    });

    advanceAfterConfirmation = mondayBoundary;
    const replacementResponse = await fetch(
      `${baseUrl}/api/subscribers/resend`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: replacementEmail }),
      },
    );
    assert.equal(replacementResponse.status, 202);
    const replacementPayload = (await replacementResponse.json()) as {
      message: string;
      cohort: string;
    };
    assert.deepEqual(Object.keys(replacementPayload).sort(), [
      "cohort",
      "message",
    ]);
    assert.equal(replacementPayload.cohort, expectedCohort);

    const replacementDelivery = confirmationDeliveries[1];
    assert.equal(replacementDelivery?.email, replacementEmail);
    assert.ok(replacementDelivery?.verifyUrl);
    const sentReplacementToken = new URL(
      replacementDelivery!.verifyUrl,
    ).searchParams.get("token");
    assert.ok(sentReplacementToken);
    assert.deepEqual(readConfirmationTokenMetadata(sentReplacementToken), {
      source: "replacement",
      cohort: replacementPayload.cohort,
      history: "native",
    });
    for (const privateValue of [replacementEmail, sentReplacementToken]) {
      assert.equal(
        JSON.stringify(replacementPayload).includes(privateValue),
        false,
      );
    }

    const replacementConfirmation = await fetch(
      `${baseUrl}/api/subscribers/verify?token=${encodeURIComponent(sentReplacementToken)}`,
      { redirect: "manual" },
    );
    assert.equal(replacementConfirmation.status, 303);
    const replacementLocation = replacementConfirmation.headers.get("location");
    assert.ok(replacementLocation);
    const replacementRedirect = new URL(replacementLocation, baseUrl);
    assert.deepEqual(
      [...replacementRedirect.searchParams.entries()],
      [
        ["subscription", "confirmed"],
        ["confirmation_source", "replacement"],
        ["confirmation_cohort", expectedCohort],
      ],
    );
    assert.equal(replacementLocation.includes(sentReplacementToken), false);
    assert.equal(replacementLocation.includes(replacementEmail), false);

    const legacyEmail = `boundary-legacy-${unique}@example.com`;
    const legacyToken = `legacy-${unique}`;
    const [legacySubscriber] = await db
      .insert(subscribersTable)
      .values({
        email: legacyEmail,
        unsubscribeTokenHash: `unsubscribe-legacy-${unique}`,
        verificationTokenHash: createHash("sha256")
          .update(legacyToken)
          .digest("hex"),
      })
      .returning({ id: subscribersTable.id });
    assert.ok(legacySubscriber);
    subscriberIds.push(legacySubscriber.id);

    const legacyConfirmation = await fetch(
      `${baseUrl}/api/subscribers/verify?token=${encodeURIComponent(legacyToken)}`,
      { redirect: "manual" },
    );
    assert.equal(legacyConfirmation.status, 303);
    const legacyLocation = legacyConfirmation.headers.get("location");
    assert.ok(legacyLocation);
    const legacyRedirect = new URL(legacyLocation, baseUrl);
    assert.deepEqual(
      [...legacyRedirect.searchParams.entries()],
      [
        ["subscription", "confirmed"],
        ["confirmation_source", "initial"],
        ["confirmation_history", "legacy"],
      ],
    );
    assert.equal(legacyRedirect.searchParams.has("confirmation_cohort"), false);
    assert.equal(legacyLocation.includes(legacyEmail), false);
    assert.equal(legacyLocation.includes(legacyToken), false);
  } finally {
    mock.timers.reset();
    connectorMock.mock.restore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (subscriberIds.length > 0) {
      await db
        .delete(subscribersTable)
        .where(inArray(subscribersTable.id, subscriberIds));
    }
  }
});

test("already-subscribed responses keep the canonical UTC Monday cohort", async () => {
  const unique = crypto.randomUUID();
  const email = `already-subscribed-${unique}@example.com`;
  const sundayBoundary = new Date("2026-09-06T23:59:59.999Z");
  const expectedCohort = "2026-08-31";
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: `unsubscribe-${unique}`,
      verifiedAt: sundayBoundary,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use("/api", engagementRouter);
  const server = serverApp.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  mock.timers.enable({ apis: ["Date"], now: sundayBoundary });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, consent: true }),
    });
    assert.equal(response.status, 202);
    const payload = (await response.json()) as {
      message: string;
      cohort: string;
    };
    assert.deepEqual(Object.keys(payload).sort(), ["cohort", "message"]);
    assert.deepEqual(payload, {
      message: "You’re already subscribed.",
      cohort: expectedCohort,
    });
    assert.equal(new Date(`${payload.cohort}T00:00:00.000Z`).getUTCDay(), 1);
  } finally {
    mock.timers.reset();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db
      .delete(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
  }
});

test("initial confirmation delivery failures return a private error and allow a fresh signup attempt", async () => {
  const unique = crypto.randomUUID();
  const email = `initial-delivery-failure-${unique}@example.com`;
  const deliveries: Array<{ email: string; token: string }> = [];
  let providerAttempts = 0;
  const providerBodyMarker = "private provider failure body";
  const attemptIdentifier = "subscriber-confirmation-initial-private-attempt";
  const connectorMock = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async (
      _connectorName: string,
      _path: string,
      options?: { body?: unknown },
    ) => {
      const body = options?.body as
        { html?: string; to?: string[] } | undefined;
      const verificationUrl = body?.html?.match(
        /href="([^"]*\/api\/subscribers\/verify\?token=([^"]+))"/,
      )?.[1];
      assert.ok(verificationUrl);
      const confirmationToken = new URL(verificationUrl).searchParams.get("token");
      assert.ok(confirmationToken);
      deliveries.push({ email: body?.to?.[0] ?? "", token: confirmationToken });
      providerAttempts += 1;

      if (providerAttempts === 1) {
        const [subscriber] = await db
          .select({ id: subscribersTable.id })
          .from(subscribersTable)
          .where(eq(subscribersTable.email, email));
        assert.ok(subscriber);
        return new Response(
          `${providerBodyMarker}; email=${email}; token=${confirmationToken}; attempt=${attemptIdentifier}; subscriber_id=${subscriber.id}`,
          { status: 500 },
        );
      }
      return new Response("", { status: 200 });
    },
  );
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use("/api", engagementRouter);
  const server = serverApp.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  let subscriberId: number | undefined;

  try {
    const failedResponse = await fetch(`${baseUrl}/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, consent: true }),
    });
    assert.equal(failedResponse.status, 500);
    assert.match(failedResponse.headers.get("content-type") ?? "", /application\/json/);
    const failedPayload = await failedResponse.json();
    assert.deepEqual(failedPayload, {
      error: "Unable to send confirmation email",
    });
    const [afterFailure] = await db
      .select({
        id: subscribersTable.id,
        verificationTokenHash: subscribersTable.verificationTokenHash,
        verifiedAt: subscribersTable.verifiedAt,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.email, email));
    assert.ok(afterFailure);
    subscriberId = afterFailure.id;
    assert.equal(afterFailure.verificationTokenHash, null);
    assert.equal(afterFailure.verifiedAt, null);

    for (const privateValue of [
      email,
      deliveries[0]!.token,
      providerBodyMarker,
      attemptIdentifier,
      String(afterFailure.id),
    ]) {
      assert.equal(JSON.stringify(failedPayload).includes(privateValue), false);
    }

    const retryResponse = await fetch(`${baseUrl}/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, consent: true }),
    });
    assert.equal(retryResponse.status, 202);
    const retryPayload = (await retryResponse.json()) as {
      cohort: string;
      message: string;
    };
    assert.deepEqual(Object.keys(retryPayload).sort(), [
      "cohort",
      "message",
    ]);
    assert.equal(providerAttempts, 2);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1]?.email, email);
    assert.notEqual(deliveries[1]?.token, deliveries[0]?.token);
    const [afterRetry] = await db
      .select({ verificationTokenHash: subscribersTable.verificationTokenHash })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, afterFailure.id));
    assert.equal(
      afterRetry?.verificationTokenHash,
      createHash("sha256").update(deliveries[1]!.token).digest("hex"),
    );
  } finally {
    connectorMock.mock.restore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (subscriberId !== undefined) {
      await db
        .delete(subscribersTable)
        .where(eq(subscribersTable.id, subscriberId));
    }
  }
});

test("ineligible resend requests keep the canonical UTC Monday cohort", async () => {
  const unique = crypto.randomUUID();
  const sundayBoundary = new Date("2026-09-06T23:59:59.999Z");
  const expectedCohort = "2026-08-31";
  const unsubscribedEmail = `unsubscribed-resend-${unique}@example.com`;
  const unsubscribedPendingEmail = `unsubscribed-pending-resend-${unique}@example.com`;
  const verifiedEmail = `verified-resend-${unique}@example.com`;
  const cooldownEmail = `cooldown-resend-${unique}@example.com`;
  const cooldownStartedAt = new Date();
  const pendingTokenHash = createHash("sha256")
    .update(`pending-token-${unique}`)
    .digest("hex");
  const [unsubscribedSubscriber] = await db
    .insert(subscribersTable)
    .values({
      email: unsubscribedEmail,
      unsubscribeTokenHash: `unsubscribe-${unique}`,
      verifiedAt: sundayBoundary,
      unsubscribedAt: sundayBoundary,
    })
    .returning({ id: subscribersTable.id });
  const [unsubscribedPendingSubscriber] = await db
    .insert(subscribersTable)
    .values({
      email: unsubscribedPendingEmail,
      unsubscribeTokenHash: `pending-unsubscribe-${unique}`,
      verificationTokenHash: pendingTokenHash,
      updatedAt: new Date(0),
      unsubscribedAt: sundayBoundary,
    })
    .returning({ id: subscribersTable.id });
  const [verifiedSubscriber] = await db
    .insert(subscribersTable)
    .values({
      email: verifiedEmail,
      unsubscribeTokenHash: `verified-unsubscribe-${unique}`,
      verifiedAt: sundayBoundary,
    })
    .returning({ id: subscribersTable.id });
  const [cooldownSubscriber] = await db
    .insert(subscribersTable)
    .values({
      email: cooldownEmail,
      unsubscribeTokenHash: `cooldown-unsubscribe-${unique}`,
      verificationTokenHash: createHash("sha256")
        .update(`cooldown-token-${unique}`)
        .digest("hex"),
      updatedAt: cooldownStartedAt,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(unsubscribedSubscriber);
  assert.ok(unsubscribedPendingSubscriber);
  assert.ok(verifiedSubscriber);
  assert.ok(cooldownSubscriber);

  let providerCalls = 0;
  const connectorMock = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async () => {
      providerCalls += 1;
      return new Response("", { status: 200 });
    },
  );
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use("/api", engagementRouter);
  const server = serverApp.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  mock.timers.enable({ apis: ["Date"], now: sundayBoundary });
  try {
    for (const email of [
      `unknown-resend-${unique}@example.com`,
      unsubscribedEmail,
      unsubscribedPendingEmail,
      verifiedEmail,
      cooldownEmail,
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/subscribers/resend`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        },
      );
      assert.equal(response.status, 202);
      const payload = (await response.json()) as {
        message: string;
        cohort: string;
      };
      assert.deepEqual(Object.keys(payload).sort(), ["cohort", "message"]);
      assert.deepEqual(payload, {
        message:
          "If that subscription is still pending and eligible, a fresh confirmation email is on its way.",
        cohort: expectedCohort,
      });
      assert.equal(new Date(`${payload.cohort}T00:00:00.000Z`).getUTCDay(), 1);
    }
    assert.equal(providerCalls, 0);
    const [unchangedPendingSubscriber] = await db
      .select({
        verificationTokenHash: subscribersTable.verificationTokenHash,
        replacementVerificationAttemptId:
          subscribersTable.replacementVerificationAttemptId,
        replacementVerificationRetryAt:
          subscribersTable.replacementVerificationRetryAt,
        updatedAt: subscribersTable.updatedAt,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, unsubscribedPendingSubscriber.id));
    assert.deepEqual(unchangedPendingSubscriber, {
      verificationTokenHash: pendingTokenHash,
      replacementVerificationAttemptId: null,
      replacementVerificationRetryAt: null,
      updatedAt: new Date(0),
    });
  } finally {
    mock.timers.reset();
    connectorMock.mock.restore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db
      .delete(subscribersTable)
      .where(
        inArray(subscribersTable.id, [
          unsubscribedSubscriber.id,
          unsubscribedPendingSubscriber.id,
          verifiedSubscriber.id,
          cooldownSubscriber.id,
        ]),
      );
  }
});

test("ambiguous replacement failure keeps its retry boundary and cohort across an API restart", async () => {
  const unique = crypto.randomUUID();
  const email = `boundary-failure-${unique}@example.com`;
  const previousToken = `previous-${unique}`;
  const sundayBoundary = new Date("2026-09-06T23:59:59.999Z");
  const mondayBoundary = new Date("2026-09-07T00:00:00.000Z");
  const expectedCohort = "2026-08-31";
  const deliveries: Array<{ email: string; verifyUrl: string }> = [];
  const logRecords: Array<{
    fields: Record<string, unknown>;
    message: string;
  }> = [];
  let providerAttempts = 0;
  const connectorMock = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async (
      _connectorName: string,
      _path: string,
      options?: { body?: unknown },
    ) => {
      const body = options?.body as
        { html?: string; to?: string[] } | undefined;
      const confirmationLink = body?.html?.match(
        /href="([^"]*\/api\/subscribers\/verify\?token=([^"]+))"/,
      );
      if (confirmationLink) {
        deliveries.push({
          email: body?.to?.[0] ?? "",
          verifyUrl: confirmationLink[1]!,
        });
      }
      providerAttempts += 1;
      if (providerAttempts === 1) {
        mock.timers.setTime(mondayBoundary.getTime());
        return new Response(
          `provider outcome unknown email=${email} token=${previousToken} attempt=subscriber-confirmation-replacement-secret subscriberId=987654`,
          { status: 500 },
        );
      }
      return new Response("", { status: 200 });
    },
  );
  const startRouteServer = async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const request = req as unknown as {
        log?: {
          error: (fields: Record<string, unknown>, message: string) => void;
        };
      };
      request.log = {
        error: (fields, message) => logRecords.push({ fields, message }),
      };
      next();
    });
    app.use("/api", engagementRouter);
    const server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    return { server, baseUrl: `http://127.0.0.1:${port}` };
  };
  let routeServer = await startRouteServer();
  const previousTokenHash = createHash("sha256")
    .update(previousToken)
    .digest("hex");
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: `unsubscribe-${unique}`,
      verificationTokenHash: previousTokenHash,
      updatedAt: new Date(
        sundayBoundary.getTime() -
          SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS -
          1_000,
      ),
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  mock.timers.enable({ apis: ["Date"], now: sundayBoundary });
  try {
    const failedResponse = await fetch(
      `${routeServer.baseUrl}/api/subscribers/resend`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      },
    );
    assert.equal(failedResponse.status, 500);
    const failedPayload = (await failedResponse.json()) as {
      error: string;
    };
    assert.deepEqual(failedPayload, {
      error: "Unable to send confirmation email",
    });
    for (const privateValue of [
      email,
      previousToken,
      "subscriber-confirmation-replacement-secret",
      "987654",
      "provider outcome unknown",
    ]) {
      assert.equal(JSON.stringify(failedPayload).includes(privateValue), false);
    }
    assert.deepEqual(logRecords, [
      {
        fields: {
          event: "subscriber_confirmation_delivery_failed",
          classification: "retryable_provider_failure",
        },
        message: "Subscriber confirmation email delivery failed",
      },
    ]);
    for (const privateValue of [
      email,
      previousToken,
      "subscriber-confirmation-replacement-secret",
      "987654",
      "provider outcome unknown",
    ]) {
      assert.equal(JSON.stringify(logRecords).includes(privateValue), false);
    }

    const [retainedAttempt] = await db
      .select({
        verificationTokenHash: subscribersTable.verificationTokenHash,
        replacementVerificationAttemptId:
          subscribersTable.replacementVerificationAttemptId,
        replacementVerificationRetryAt:
          subscribersTable.replacementVerificationRetryAt,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.ok(retainedAttempt?.replacementVerificationAttemptId);
    assert.ok(retainedAttempt?.replacementVerificationRetryAt);
    const activeRetryAt = retainedAttempt.replacementVerificationRetryAt;
    assert.equal(
      retainedAttempt.replacementVerificationAttemptId.split("~", 1)[0],
      expectedCohort,
    );
    assert.ok(deliveries[0]?.verifyUrl);
    const firstRetryToken = new URL(deliveries[0]!.verifyUrl).searchParams.get(
      "token",
    );
    assert.ok(firstRetryToken);
    assert.equal(
      retainedAttempt.verificationTokenHash,
      createHash("sha256").update(firstRetryToken).digest("hex"),
    );
    assert.equal(
      readConfirmationTokenMetadata(firstRetryToken).cohort,
      expectedCohort,
    );

    await new Promise<void>((resolve, reject) =>
      routeServer.server.close((error) => (error ? reject(error) : resolve())),
    );
    routeServer = await startRouteServer();

    const blockedResponses = await Promise.all(
      [0, 1].map(() =>
        fetch(`${routeServer.baseUrl}/api/subscribers/resend`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        }),
      ),
    );
    for (const blockedResponse of blockedResponses) {
      assert.equal(blockedResponse.status, 202);
      const blockedPayload = (await blockedResponse.json()) as {
        message: string;
        cohort: string;
      };
      assert.deepEqual(Object.keys(blockedPayload).sort(), [
        "cohort",
        "message",
      ]);
      assert.equal(blockedPayload.cohort, expectedCohort);
      const privateValues: string[] = [email, firstRetryToken];
      for (const privateValue of privateValues) {
        assert.equal(
          JSON.stringify(blockedPayload).includes(privateValue),
          false,
        );
      }
    }
    assert.equal(providerAttempts, 1);
    assert.equal(deliveries.length, 1);

    const [stillBlockedAttempt] = await db
      .select({
        verificationTokenHash: subscribersTable.verificationTokenHash,
        replacementVerificationAttemptId:
          subscribersTable.replacementVerificationAttemptId,
        replacementVerificationRetryAt:
          subscribersTable.replacementVerificationRetryAt,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(
      stillBlockedAttempt?.replacementVerificationAttemptId,
      retainedAttempt.replacementVerificationAttemptId,
    );
    assert.equal(
      stillBlockedAttempt?.verificationTokenHash,
      retainedAttempt.verificationTokenHash,
    );
    assert.equal(
      stillBlockedAttempt?.replacementVerificationRetryAt?.getTime(),
      activeRetryAt.getTime(),
    );

    await db
      .update(subscribersTable)
      .set({
        replacementVerificationRetryAt: sql`CURRENT_TIMESTAMP - interval '1 millisecond'`,
      })
      .where(eq(subscribersTable.id, subscriber.id));

    const retryResponse = await fetch(`${routeServer.baseUrl}/api/subscribers/resend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    assert.equal(retryResponse.status, 202);
    const retryPayload = (await retryResponse.json()) as {
      message: string;
      cohort: string;
    };
    assert.deepEqual(Object.keys(retryPayload).sort(), ["cohort", "message"]);
    assert.equal(retryPayload.cohort, expectedCohort);
    assert.equal(providerAttempts, 2);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0]?.email, email);
    assert.equal(deliveries[1]?.email, email);
    assert.equal(deliveries[1]?.verifyUrl, deliveries[0]?.verifyUrl);
    const secondRetryToken = new URL(deliveries[1]!.verifyUrl).searchParams.get(
      "token",
    );
    assert.equal(secondRetryToken, firstRetryToken);
    assert.deepEqual(readConfirmationTokenMetadata(secondRetryToken!), {
      source: "replacement",
      cohort: expectedCohort,
      history: "native",
    });

    const [finalizedAttempt] = await db
      .select({
        verificationTokenHash: subscribersTable.verificationTokenHash,
        replacementVerificationAttemptId:
          subscribersTable.replacementVerificationAttemptId,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(finalizedAttempt?.replacementVerificationAttemptId, null);
    assert.equal(
      finalizedAttempt?.verificationTokenHash,
      createHash("sha256").update(firstRetryToken).digest("hex"),
    );
  } finally {
    mock.timers.reset();
    connectorMock.mock.restore();
    await new Promise<void>((resolve, reject) =>
      routeServer.server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("initial confirmation failures log a safe classification and return a private response", async () => {
  const unique = crypto.randomUUID();
  const email = `initial-failure-${unique}@example.com`;
  const providerBody =
    `provider rejected email=${email} token=confirmation-token-${unique} ` +
    `attempt=confirmation-attempt-${unique} subscriberId=987654`;
  const logRecords: Array<{
    fields: Record<string, unknown>;
    message: string;
  }> = [];
  const handledErrors: unknown[] = [];
  const connectorMock = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async () => new Response(providerBody, { status: 400 }),
  );
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use((req, _res, next) => {
    const request = req as unknown as {
      log?: {
        error: (fields: Record<string, unknown>, message: string) => void;
      };
    };
    request.log = {
      error: (fields, message) => logRecords.push({ fields, message }),
    };
    next();
  });
  serverApp.use("/api", engagementRouter);
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    handledErrors.push(error);
    res.status(500).json({ error: "Internal server error" });
  };
  serverApp.use(errorHandler);
  const server = serverApp.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, consent: true }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Unable to send confirmation email",
    });
    assert.equal(handledErrors.length, 0);
    assert.deepEqual(logRecords, [
      {
        fields: {
          event: "subscriber_confirmation_delivery_failed",
          classification: "permanent_provider_failure",
        },
        message: "Subscriber confirmation email delivery failed",
      },
    ]);
    const capturedLogs = JSON.stringify({
      logRecords,
      handledErrors: handledErrors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    });
    for (const privateValue of [
      email,
      `confirmation-token-${unique}`,
      `confirmation-attempt-${unique}`,
      "987654",
      "provider rejected",
    ]) {
      assert.equal(capturedLogs.includes(privateValue), false);
    }

    const [subscriber] = await db
      .select({ verificationTokenHash: subscribersTable.verificationTokenHash })
      .from(subscribersTable)
      .where(eq(subscribersTable.email, email));
    assert.equal(subscriber?.verificationTokenHash, null);
  } finally {
    connectorMock.mock.restore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.delete(subscribersTable).where(eq(subscribersTable.email, email));
  }
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
    assert.equal(response.headers.get("cache-control"), "no-store");

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
      assert.equal(errorResponse.headers.get("cache-control"), "no-store");
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

test("malformed confirmation links do not echo token data or redirect markers", async () => {
  const unique = crypto.randomUUID();
  const privateEmail = `malformed-confirmation-${unique}@example.com`;
  const privateCohort = "2026-09-07";
  const malformedToken =
    `not-a-confirmation.${privateEmail}~${privateCohort}` +
    "?confirmation_history=legacy";
  const app = express();
  app.use("/api", engagementRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/subscribers/verify?token=${encodeURIComponent(malformedToken)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.headers.get("content-type")?.includes("text/html"),
      true,
    );

    const body = await response.text();
    assert.match(body, /That link has expired\./);
    for (const privateValue of [malformedToken, privateEmail, privateCohort]) {
      assert.equal(body.includes(privateValue), false);
    }
    for (const marker of [
      "confirmation_source",
      "confirmation_cohort",
      "confirmation_history",
    ]) {
      assert.equal(body.includes(marker), false);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("malformed unsubscribe links leave active subscriptions unchanged and do not echo subscriber data or success markers", async () => {
  const unique = crypto.randomUUID();
  const privateEmail = `malformed-unsubscribe-${unique}@example.com`;
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email: privateEmail,
      unsubscribeTokenHash: `unsubscribe-secret-${unique}`,
      verifiedAt: new Date(),
      unsubscribedAt: null,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const privateSubscriber = `subscriber-${subscriber.id}`;
  const malformedToken =
    `not-a-valid-unsubscribe.${privateSubscriber}.${privateEmail}`;
  const app = express();
  app.use("/api", engagementRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/subscribers/unsubscribe?token=${encodeURIComponent(malformedToken)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(
      response.headers.get("content-type")?.includes("text/html"),
      true,
    );

    const body = await response.text();
    assert.match(body, /That link has expired\./);
    const [unchangedSubscriber] = await db
      .select({ unsubscribedAt: subscribersTable.unsubscribedAt })
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.ok(unchangedSubscriber, "the active subscriber must still exist");
    assert.equal(unchangedSubscriber.unsubscribedAt, null);
    for (const privateValue of [
      malformedToken,
      privateEmail,
      privateSubscriber,
    ]) {
      assert.equal(body.includes(privateValue), false);
    }
    for (const marker of [
      "You’re unsubscribed.",
      "subscription=confirmed",
      "confirmation_source",
      "confirmation_cohort",
      "confirmation_history",
    ]) {
      assert.equal(body.includes(marker), false);
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

test("unsubscribe responses are never cached for missing, valid, or expired links", async () => {
  const unique = crypto.randomUUID();
  const [subscriber] = await db.insert(subscribersTable).values({
    email: `unsubscribe-cache-${unique}@example.com`,
    unsubscribeTokenHash: unique,
    verifiedAt: new Date(),
  }).returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const app = express();
  app.use("/api", engagementRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/api/subscribers/unsubscribe`;
  const tokenUrl = `${url}?token=${encodeURIComponent(createUnsubscribeToken(subscriber.id))}`;

  try {
    const missing = await fetch(url);
    assert.equal(missing.status, 400);
    assert.equal(missing.headers.get("cache-control"), "private, no-store");
    assert.match(await missing.text(), /That link isn’t valid\./);

    const valid = await fetch(tokenUrl);
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("cache-control"), "private, no-store");
    assert.match(await valid.text(), /You’re unsubscribed\./);
    const [updated] = await db.select().from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.ok(updated?.unsubscribedAt);

    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
    const expired = await fetch(tokenUrl);
    assert.equal(expired.status, 400);
    assert.equal(expired.headers.get("cache-control"), "private, no-store");
    assert.match(await expired.text(), /That link has expired\./);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
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

test("old legacy confirmation links expire safely after a replacement is sent", async () => {
  const unique = crypto.randomUUID();
  const email = `legacy-replacement-${unique}@example.com`;
  const originalToken = `legacy-pending-${unique}`;
  const originalTokenHash = createHash("sha256")
    .update(originalToken)
    .digest("hex");
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: `unsubscribe-secret-${unique}`,
      verificationTokenHash: originalTokenHash,
      updatedAt: new Date(
        Date.now() - SUBSCRIBER_CONFIRMATION_RESEND_COOLDOWN_MS - 1_000,
      ),
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const deliveries: Array<{
    verifyUrl: string;
    idempotencyKey: string | undefined;
  }> = [];
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
    assert.equal(
      await requestSubscriberConfirmationReplacement(
        email,
        "example.com",
        async (_to, verifyUrl, idempotencyKey) => {
          deliveries.push({ verifyUrl, idempotencyKey });
        },
      ),
      true,
    );
    assert.equal(deliveries.length, 1);

    const replacementToken = new URL(
      deliveries[0]!.verifyUrl,
    ).searchParams.get("token");
    assert.ok(replacementToken);
    const replacementMetadata = readConfirmationTokenMetadata(replacementToken);
    assert.equal(replacementMetadata.source, "replacement");
    assert.ok(replacementMetadata.cohort);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/subscribers/verify?token=${encodeURIComponent(originalToken)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.headers.get("content-type")?.includes("text/html"),
      true,
    );

    const body = await response.text();
    assert.match(body, /That link has expired\./);
    for (const privateValue of [
      originalToken,
      originalTokenHash,
      email,
      replacementToken,
      replacementMetadata.cohort,
      deliveries[0]?.idempotencyKey ?? "",
    ]) {
      assert.ok(privateValue);
      assert.equal(body.includes(privateValue), false);
    }
    for (const marker of [
      "confirmation_source",
      "confirmation_cohort",
      "confirmation_history",
      "subscriber-confirmation-replacement",
      "replacementVerificationAttemptId",
    ]) {
      assert.equal(body.includes(marker), false);
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

test("admin welcome email status endpoint exposes retryable states without delivery secrets", async () => {
  const unique = crypto.randomUUID();
  const databaseNowResult = await pool.query<{ now: Date }>(
    "select CURRENT_TIMESTAMP as now",
  );
  const databaseNow = databaseNowResult.rows[0]!.now;
  const activeClaimedAt = new Date(
    databaseNow.getTime() - WELCOME_EMAIL_CLAIM_LEASE_MS + 1_000,
  );
  const expiredClaimedAt = new Date(
    databaseNow.getTime() - WELCOME_EMAIL_CLAIM_LEASE_MS - 1_000,
  );
  const subscriberRows = await db
    .insert(subscribersTable)
    .values([
      {
        email: `welcome-active-${unique}@example.com`,
        verificationTokenHash: `verification-secret-${unique}`,
        unsubscribeTokenHash: `unsubscribe-secret-${unique}`,
        verifiedAt: databaseNow,
        welcomeEmailStatus: "claimed",
        welcomeEmailClaimedAt: activeClaimedAt,
        welcomeEmailAttemptCount: 1,
      },
      {
        email: `welcome-expired-${unique}@example.com`,
        verificationTokenHash: `verification-secret-expired-${unique}`,
        unsubscribeTokenHash: `unsubscribe-secret-expired-${unique}`,
        verifiedAt: databaseNow,
        welcomeEmailStatus: "claimed",
        welcomeEmailClaimedAt: expiredClaimedAt,
        welcomeEmailAttemptCount: 2,
      },
      {
        email: `welcome-failed-${unique}@example.com`,
        verificationTokenHash: `verification-secret-failed-${unique}`,
        unsubscribeTokenHash: `unsubscribe-secret-failed-${unique}`,
        verifiedAt: databaseNow,
        welcomeEmailStatus: "failed",
        welcomeEmailClaimedAt: expiredClaimedAt,
        welcomeEmailFailedAt: databaseNow,
        welcomeEmailLastError: "temporary provider outage",
        welcomeEmailAttemptCount: 3,
      },
      {
        email: `welcome-permanent-${unique}@example.com`,
        verificationTokenHash: `verification-secret-permanent-${unique}`,
        unsubscribeTokenHash: `unsubscribe-secret-permanent-${unique}`,
        verifiedAt: databaseNow,
        welcomeEmailStatus: "permanently_failed",
        welcomeEmailClaimedAt: expiredClaimedAt,
        welcomeEmailFailedAt: databaseNow,
        welcomeEmailLastError: "provider rejected address",
        welcomeEmailAttemptCount: 4,
      },
      {
        email: `welcome-delivered-${unique}@example.com`,
        verificationTokenHash: `verification-secret-delivered-${unique}`,
        unsubscribeTokenHash: `unsubscribe-secret-delivered-${unique}`,
        verifiedAt: databaseNow,
        welcomeEmailStatus: "delivered",
        welcomeEmailDeliveredAt: databaseNow,
        welcomeEmailAttemptCount: 1,
      },
    ])
    .returning({ id: subscribersTable.id });
  const app = express();
  app.use(express.json());
  app.use("/api", adminRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const unauthorized = await fetch(
      `http://127.0.0.1:${port}/api/admin/welcome-emails`,
    );
    assert.equal(unauthorized.status, 401);

    // This test exercises the protected email list, not password configuration.
    const { createAdminCookie } = await import("../lib/adminSession");
    const cookie = createAdminCookie();

    const invalidLimit = await fetch(
      `http://127.0.0.1:${port}/api/admin/welcome-emails?limit=101`,
      { headers: { cookie: cookie.split(";")[0]! } },
    );
    assert.equal(invalidLimit.status, 400);
    const invalidCursor = await fetch(
      `http://127.0.0.1:${port}/api/admin/welcome-emails?cursor=not-a-cursor`,
      { headers: { cookie: cookie.split(";")[0]! } },
    );
    assert.equal(invalidCursor.status, 400);

    const firstPageResponse = await fetch(
      `http://127.0.0.1:${port}/api/admin/welcome-emails?limit=2`,
      { headers: { cookie: cookie.split(";")[0]! } },
    );
    assert.equal(firstPageResponse.status, 200);
    const firstPage = (await firstPageResponse.json()) as {
      records: Array<Record<string, unknown>>;
      nextCursor: string | null;
      backlog: {
        retryableCount: number;
        oldestRetryAt: string | null;
        oldestRetryAgeMinutes: number | null;
        repeatedFailureCount: number;
        state: string;
      };
    };
    assert.equal(firstPage.records.length, 2);
    assert.equal(firstPage.nextCursor, String(subscriberRows[1]!.id));
    assert.equal(firstPage.backlog.retryableCount, 2);
    assert.equal(firstPage.backlog.repeatedFailureCount, 1);
    assert.equal(firstPage.backlog.state, "attention");
    assert.ok(firstPage.backlog.oldestRetryAt);
    assert.ok((firstPage.backlog.oldestRetryAgeMinutes ?? 0) >= 15);
    assert.deepEqual(
      firstPage.records.map((record) => record.id),
      subscriberRows.slice(0, 2).map((row) => row.id),
    );

    await db
      .update(subscribersTable)
      .set({
        welcomeEmailStatus: "delivered",
        welcomeEmailDeliveredAt: databaseNow,
      })
      .where(eq(subscribersTable.id, subscriberRows[0]!.id));
    await db
      .update(subscribersTable)
      .set({
        welcomeEmailStatus: "failed",
        welcomeEmailFailedAt: databaseNow,
        welcomeEmailLastError: "new failure after first page",
      })
      .where(eq(subscribersTable.id, subscriberRows[4]!.id));
    const [insertedSubscriber] = await db
      .insert(subscribersTable)
      .values({
        email: `welcome-inserted-${unique}@example.com`,
        verificationTokenHash: `verification-secret-inserted-${unique}`,
        unsubscribeTokenHash: `unsubscribe-secret-inserted-${unique}`,
        verifiedAt: databaseNow,
        welcomeEmailStatus: "failed",
        welcomeEmailClaimedAt: databaseNow,
        welcomeEmailFailedAt: databaseNow,
        welcomeEmailLastError: "inserted after first page",
        welcomeEmailAttemptCount: 1,
      })
      .returning({ id: subscribersTable.id });
    assert.ok(insertedSubscriber);
    subscriberRows.push(insertedSubscriber);

    const secondPageResponse = await fetch(
      `http://127.0.0.1:${port}/api/admin/welcome-emails?limit=10&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      { headers: { cookie: cookie.split(";")[0]! } },
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = (await secondPageResponse.json()) as {
      records: Array<Record<string, unknown>>;
      nextCursor: string | null;
      backlog: {
        retryableCount: number;
        oldestRetryAt: string | null;
        oldestRetryAgeMinutes: number | null;
        repeatedFailureCount: number;
        state: string;
      };
    };
    assert.equal(secondPage.nextCursor, null);
    assert.equal(secondPage.backlog.retryableCount, 4);
    assert.equal(secondPage.backlog.state, "attention");
    assert.deepEqual(
      secondPage.records.map((record) => record.id),
      subscriberRows.slice(2).map((row) => row.id),
    );
    assert.equal(secondPage.records.at(-1)?.status, "failed");

    const records = [...firstPage.records, ...secondPage.records];
    assert.deepEqual(
      records
        .map((record) => [record.email, record.status])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
      [
        [`welcome-active-${unique}@example.com`, "active_claim"],
        [`welcome-delivered-${unique}@example.com`, "failed"],
        [`welcome-expired-${unique}@example.com`, "expired_claim"],
        [`welcome-failed-${unique}@example.com`, "failed"],
        [`welcome-inserted-${unique}@example.com`, "failed"],
        [`welcome-permanent-${unique}@example.com`, "permanently_failed"],
      ],
    );

    const failed = records.find((record) =>
      String(record.email).includes("welcome-failed-"),
    );
    assert.ok(failed);
    assert.equal(failed.lastError, "temporary provider outage");
    assert.equal(failed.attemptCount, 3);
    assert.deepEqual(Object.keys(failed).sort(), [
      "attemptCount",
      "claimedAt",
      "email",
      "failedAt",
      "id",
      "lastError",
      "status",
    ]);

    const body = JSON.stringify(records);
    assert.doesNotMatch(body, /verification-secret|unsubscribe-secret/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db
      .delete(subscribersTable)
      .where(
        inArray(
          subscribersTable.id,
          subscriberRows.map((row) => row.id),
        ),
      );
  }
});

test("admin deferred confirmation status exposes only aggregate retry timing", async () => {
  const unique = crypto.randomUUID();
  const databaseNowResult = await pool.query<{ now: Date }>(
    "select CURRENT_TIMESTAMP as now",
  );
  const databaseNow = databaseNowResult.rows[0]!.now;
  const firstRetryAt = new Date(databaseNow.getTime() + 5 * 60_000);
  const secondRetryAt = new Date(databaseNow.getTime() + 8 * 60_000);
  const expiredRetryAt = new Date(databaseNow.getTime() - 1_000);
  const subscriberRows: Array<{ id: number }> = [];
  const app = express();
  app.use(express.json());
  app.use("/api", adminRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const unauthorized = await fetch(
      `${baseUrl}/api/admin/deferred-confirmations`,
    );
    assert.equal(unauthorized.status, 401);

    const { createAdminCookie } = await import("../lib/adminSession");
    const cookie = createAdminCookie();
    const headers = { cookie: cookie.split(";")[0]! };
    const baselineResponse = await fetch(
      `${baseUrl}/api/admin/deferred-confirmations`,
      { headers },
    );
    assert.equal(baselineResponse.status, 200);
    const baseline = (await baselineResponse.json()) as {
      deferredCount: number;
      nextRetryAt: string | null;
    };
    assert.deepEqual(Object.keys(baseline).sort(), [
      "deferredCount",
      "nextRetryAt",
    ]);

    const rows = await db
      .insert(subscribersTable)
      .values([
        {
          email: `deferred-first-${unique}@example.com`,
          verificationTokenHash: `verification-secret-first-${unique}`,
          replacementVerificationAttemptId: `attempt-first-${unique}`,
          replacementVerificationRetryAt: firstRetryAt,
          unsubscribeTokenHash: `unsubscribe-secret-first-${unique}`,
        },
        {
          email: `deferred-second-${unique}@example.com`,
          verificationTokenHash: `verification-secret-second-${unique}`,
          replacementVerificationAttemptId: `attempt-second-${unique}`,
          replacementVerificationRetryAt: secondRetryAt,
          unsubscribeTokenHash: `unsubscribe-secret-second-${unique}`,
        },
        {
          email: `deferred-expired-${unique}@example.com`,
          verificationTokenHash: `verification-secret-expired-${unique}`,
          replacementVerificationAttemptId: `attempt-expired-${unique}`,
          replacementVerificationRetryAt: expiredRetryAt,
          unsubscribeTokenHash: `unsubscribe-secret-expired-${unique}`,
        },
        {
          email: `deferred-verified-${unique}@example.com`,
          verificationTokenHash: `verification-secret-verified-${unique}`,
          replacementVerificationAttemptId: `attempt-verified-${unique}`,
          replacementVerificationRetryAt: firstRetryAt,
          unsubscribeTokenHash: `unsubscribe-secret-verified-${unique}`,
          verifiedAt: databaseNow,
        },
        {
          email: `deferred-unsubscribed-${unique}@example.com`,
          verificationTokenHash: `verification-secret-unsubscribed-${unique}`,
          replacementVerificationAttemptId: `attempt-unsubscribed-${unique}`,
          replacementVerificationRetryAt: firstRetryAt,
          unsubscribeTokenHash: `unsubscribe-secret-unsubscribed-${unique}`,
          unsubscribedAt: databaseNow,
        },
      ])
      .returning({ id: subscribersTable.id });
    subscriberRows.push(...rows);

    const statusResponse = await fetch(
      `${baseUrl}/api/admin/deferred-confirmations`,
      { headers },
    );
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get("cache-control"), "private, no-store");
    const status = (await statusResponse.json()) as {
      deferredCount: number;
      nextRetryAt: string | null;
    };
    assert.deepEqual(Object.keys(status).sort(), [
      "deferredCount",
      "nextRetryAt",
    ]);
    assert.equal(status.deferredCount, baseline.deferredCount + 2);
    const baselineNextRetryAt = baseline.nextRetryAt
      ? new Date(baseline.nextRetryAt)
      : null;
    const expectedNextRetryAt =
      baselineNextRetryAt && baselineNextRetryAt < firstRetryAt
        ? baselineNextRetryAt
        : firstRetryAt;
    assert.equal(
      new Date(status.nextRetryAt!).toISOString(),
      expectedNextRetryAt.toISOString(),
    );
    const serialized = JSON.stringify(status);
    for (const privateValue of [
      unique,
      "verification-secret",
      "unsubscribe-secret",
      "attempt-first",
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (subscriberRows.length > 0) {
      await db
        .delete(subscribersTable)
        .where(
          inArray(
            subscribersTable.id,
            subscriberRows.map((row) => row.id),
          ),
        );
    }
  }
});

test("welcome recovery backlog states distinguish empty, healthy, and stuck work", () => {
  assert.equal(
    classifyWelcomeEmailBacklog({
      retryableCount: 0,
      oldestRetryAgeMinutes: null,
      repeatedFailureCount: 0,
    }),
    "clear",
  );
  assert.equal(
    classifyWelcomeEmailBacklog({
      retryableCount: 2,
      oldestRetryAgeMinutes: 1,
      repeatedFailureCount: 0,
    }),
    "healthy",
  );
  assert.equal(
    classifyWelcomeEmailBacklog({
      retryableCount: 2,
      oldestRetryAgeMinutes: 1,
      repeatedFailureCount: 1,
    }),
    "attention",
  );
  assert.equal(
    classifyWelcomeEmailBacklog({
      retryableCount: WELCOME_EMAIL_RECOVERY_BATCH_SIZE + 1,
      oldestRetryAgeMinutes: 0,
      repeatedFailureCount: 0,
    }),
    "attention",
  );
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

test("welcome recovery survives failed finalization and failed-state persistence", async () => {
  const unique = crypto.randomUUID();
  const email = `welcome-double-outage-${unique}@example.com`;
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
  let updateAttempts = 0;
  const originalUpdate = db.update.bind(db);
  const updateMock = mock.method(
    db,
    "update",
    (...args: Parameters<typeof db.update>) => {
      updateAttempts += 1;
      if (updateAttempts === 2) {
        throw new Error("database still unavailable");
      }
      return originalUpdate(...args);
    },
  );

  try {
    assert.equal(
      await deliverSubscriberWelcome(
        { id: subscriber.id, email },
        "https://example.com",
        async (_to, unsubscribeUrl, idempotencyKey) => {
          attempts.push({ unsubscribeUrl, idempotencyKey });
        },
        async () => {
          throw new Error("database temporarily unavailable");
        },
      ),
      "failed",
    );
    assert.equal(updateAttempts, 2);
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

    const [claimed] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.equal(claimed?.welcomeEmailStatus, "claimed");
    assert.equal(claimed?.welcomeEmailAttemptCount, 1);
    assert.ok(claimed?.welcomeEmailClaimedAt);
    assert.equal(claimed?.welcomeEmailFailedAt, null);
    assert.equal(claimed?.welcomeEmailLastError, null);

    updateMock.mock.restore();
    await db
      .update(subscribersTable)
      .set({
        welcomeEmailClaimedAt: new Date(
          Date.now() - WELCOME_EMAIL_CLAIM_LEASE_MS - 1_000,
        ),
      })
      .where(eq(subscribersTable.id, subscriber.id));

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
    updateMock.mock.restore();
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

test("welcome recovery skips an unsubscribed subscriber with an expired retry lease", async () => {
  const unique = crypto.randomUUID();
  const email = `welcome-unsubscribed-${unique}@example.com`;
  const databaseNowResult = await pool.query<{ now: Date }>(
    "select CURRENT_TIMESTAMP as now",
  );
  const databaseNow = databaseNowResult.rows[0]!.now;
  const expiredClaimedAt = new Date(
    databaseNow.getTime() - WELCOME_EMAIL_CLAIM_LEASE_MS - 1_000,
  );
  const [subscriber] = await db
    .insert(subscribersTable)
    .values({
      email,
      unsubscribeTokenHash: unique,
      verifiedAt: databaseNow,
      welcomeEmailStatus: "claimed",
      welcomeEmailClaimedAt: expiredClaimedAt,
      welcomeEmailAttemptCount: 1,
    })
    .returning({ id: subscribersTable.id });
  assert.ok(subscriber);

  const deliveries: string[] = [];
  const outcomes: string[] = [];
  try {
    await db
      .update(subscribersTable)
      .set({ unsubscribedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(subscribersTable.id, subscriber.id));

    await recoverWelcomeEmails(
      "https://example.com",
      (outcome, subscriberId) => {
        assert.equal(subscriberId, subscriber.id);
        outcomes.push(outcome);
      },
      async (to) => {
        deliveries.push(to);
      },
    );

    assert.deepEqual(outcomes, []);
    assert.deepEqual(deliveries, []);

    const [unsubscribed] = await db
      .select()
      .from(subscribersTable)
      .where(eq(subscribersTable.id, subscriber.id));
    assert.ok(unsubscribed?.unsubscribedAt);
    assert.equal(unsubscribed?.welcomeEmailStatus, "claimed");
    assert.equal(unsubscribed?.welcomeEmailAttemptCount, 1);
    assert.equal(
      unsubscribed?.welcomeEmailClaimedAt?.getTime(),
      expiredClaimedAt.getTime(),
    );
  } finally {
    await db.delete(subscribersTable).where(eq(subscribersTable.id, subscriber.id));
  }
});

test("welcome backlog summary matches recovery eligibility and admin pages", async () => {
  const unique = crypto.randomUUID();
  const { rows } = await db.execute<{ now: Date }>(
    sql`SELECT CURRENT_TIMESTAMP AS now`,
  );
  const databaseTime = rows[0];
  assert.ok(databaseTime);
  const now = new Date(String(databaseTime.now)).getTime();
  const oldestFailureAt = new Date(now - 3_650 * 24 * 60 * 60 * 1_000);
  const fallbackClaimedAt = new Date(now - 3_651 * 24 * 60 * 60 * 1_000);
  const expiredClaimedAt = new Date(
    now - WELCOME_EMAIL_CLAIM_LEASE_MS - 60_000,
  );
  const baseline = await getWelcomeEmailAdminBacklog();
  const deliveredEmail = `welcome-summary-delivered-${unique}@example.com`;

  const inserted = await db
    .insert(subscribersTable)
    .values([
      {
        email: `welcome-summary-failed-${unique}@example.com`,
        unsubscribeTokenHash: `welcome-summary-failed-${unique}`,
        verifiedAt: new Date(now),
        welcomeEmailStatus: "failed",
        welcomeEmailFailedAt: oldestFailureAt,
        welcomeEmailAttemptCount: 3,
      },
      {
        email: `welcome-summary-fallback-${unique}@example.com`,
        unsubscribeTokenHash: `welcome-summary-fallback-${unique}`,
        verifiedAt: new Date(now),
        welcomeEmailStatus: "failed",
        welcomeEmailClaimedAt: fallbackClaimedAt,
        welcomeEmailAttemptCount: 2,
      },
      {
        email: `welcome-summary-expired-${unique}@example.com`,
        unsubscribeTokenHash: `welcome-summary-expired-${unique}`,
        verifiedAt: new Date(now),
        welcomeEmailStatus: "claimed",
        welcomeEmailClaimedAt: expiredClaimedAt,
        welcomeEmailAttemptCount: 3,
      },
      {
        email: `welcome-summary-active-${unique}@example.com`,
        unsubscribeTokenHash: `welcome-summary-active-${unique}`,
        verifiedAt: new Date(now),
        welcomeEmailStatus: "claimed",
        welcomeEmailClaimedAt: new Date(now),
        welcomeEmailAttemptCount: 3,
      },
      {
        email: `welcome-summary-unverified-${unique}@example.com`,
        unsubscribeTokenHash: `welcome-summary-unverified-${unique}`,
        welcomeEmailStatus: "failed",
        welcomeEmailAttemptCount: 3,
      },
      {
        email: `welcome-summary-unsubscribed-${unique}@example.com`,
        unsubscribeTokenHash: `welcome-summary-unsubscribed-${unique}`,
        verifiedAt: new Date(now),
        unsubscribedAt: new Date(now),
        welcomeEmailStatus: "failed",
        welcomeEmailAttemptCount: 3,
      },
      {
        email: `welcome-summary-permanent-${unique}@example.com`,
        unsubscribeTokenHash: `welcome-summary-permanent-${unique}`,
        verifiedAt: new Date(now),
        welcomeEmailStatus: "permanently_failed",
        welcomeEmailAttemptCount: 3,
      },
      {
        email: deliveredEmail,
        unsubscribeTokenHash: `welcome-summary-delivered-${unique}`,
        verifiedAt: new Date(now),
        welcomeEmailStatus: "delivered",
        welcomeEmailAttemptCount: 3,
      },
    ])
    .returning({ id: subscribersTable.id });
  const insertedIds = inserted.map(({ id }) => id);

  try {
    const backlog = await getWelcomeEmailAdminBacklog();
    assert.equal(backlog.retryableCount, baseline.retryableCount + 3);
    assert.equal(
      backlog.repeatedFailureCount,
      baseline.repeatedFailureCount + 2,
    );
    const expectedOldestRetryAt = [
      baseline.oldestRetryAt,
      oldestFailureAt,
      fallbackClaimedAt,
      expiredClaimedAt,
    ]
      .filter((date): date is Date => date !== null)
      .reduce((oldest, date) =>
        date.getTime() < oldest.getTime() ? date : oldest,
      );
    assert.equal(
      backlog.oldestRetryAt?.getTime(),
      expectedOldestRetryAt.getTime(),
    );

    const [deliveredSubscriber] = await db
      .select({ id: subscribersTable.id })
      .from(subscribersTable)
      .where(eq(subscribersTable.email, deliveredEmail));
    assert.ok(deliveredSubscriber);
    const expectedAdminIds = new Set(
      inserted
        .filter(({ id }) => id !== deliveredSubscriber?.id)
        .map(({ id }) => id),
    );
    const listedIds = new Set<number>();
    const firstId = Math.min(...insertedIds);
    let cursor = firstId > 1 ? String(firstId - 1) : undefined;
    let pageBacklog:
      | Awaited<ReturnType<typeof listWelcomeEmailAdminRecords>>["backlog"]
      | undefined;

    do {
      const page = await listWelcomeEmailAdminRecords({ limit: 100, cursor });
      pageBacklog = page.backlog;
      for (const record of page.records) {
        if (expectedAdminIds.has(record.id)) listedIds.add(record.id);
      }
      if (
        [...expectedAdminIds].every((id) => listedIds.has(id)) ||
        page.nextCursor === null
      ) {
        break;
      }
      cursor = page.nextCursor;
    } while (true);

    assert.deepEqual([...listedIds].sort((a, b) => a - b), [
      ...expectedAdminIds,
    ].sort((a, b) => a - b));
    assert.ok(pageBacklog);
    assert.equal(pageBacklog.retryableCount, backlog.retryableCount);
    assert.equal(
      pageBacklog.oldestRetryAt?.getTime(),
      backlog.oldestRetryAt?.getTime(),
    );
    assert.equal(
      pageBacklog.repeatedFailureCount,
      backlog.repeatedFailureCount,
    );
    assert.equal(pageBacklog.state, backlog.state);
  } finally {
    await db
      .delete(subscribersTable)
      .where(inArray(subscribersTable.id, insertedIds));
  }
});

test("welcome recovery stays bounded with a large mixed subscriber backlog", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const unique = crypto.randomUUID();
    const populationSize = 2_000;

    await client.query(
      `
        INSERT INTO subscribers (
          email,
          unsubscribe_token_hash,
          verified_at,
          unsubscribed_at,
          welcome_email_status,
          welcome_email_claimed_at
        )
        SELECT
          format('%s-%s-%s@example.com', $1::text, population, subscriber),
          format('%s-%s-%s', $1::text, population, subscriber),
          CASE
            WHEN population = 'unverified' THEN NULL
            ELSE CURRENT_TIMESTAMP
          END,
          CASE
            WHEN population = 'unsubscribed' THEN CURRENT_TIMESTAMP
            ELSE NULL
          END,
          CASE population
            WHEN 'delivered' THEN 'delivered'
            WHEN 'failed' THEN 'failed'
            WHEN 'claimed' THEN 'claimed'
            WHEN 'active_claim' THEN 'claimed'
            ELSE NULL
          END,
          CASE population
            WHEN 'failed' THEN CURRENT_TIMESTAMP - interval '1 day'
            WHEN 'claimed' THEN CURRENT_TIMESTAMP - interval '1 day'
            WHEN 'active_claim' THEN CURRENT_TIMESTAMP
            ELSE NULL
          END
        FROM unnest(ARRAY[
          'unverified',
          'unsubscribed',
          'delivered',
          'failed',
          'claimed',
          'active_claim'
        ]::text[]) AS populations(population)
        CROSS JOIN generate_series(1, $2::int) AS subscribers(subscriber)
      `,
      [unique, populationSize],
    );
    await client.query("ANALYZE subscribers");

    const recoveryIndexOrder = await client.query<{
      first_column: string;
      second_column: string;
    }>(
      `
        SELECT
          pg_get_indexdef(idx.indexrelid, 1, true) AS first_column,
          pg_get_indexdef(idx.indexrelid, 2, true) AS second_column
        FROM pg_index AS idx
        WHERE idx.indexrelid = 'subscribers_welcome_recovery_idx'::regclass
      `,
    );
    assert.deepEqual(recoveryIndexOrder.rows[0], {
      first_column: "welcome_email_claimed_at",
      second_column: "id",
    });

    const explainResult = await client.query<{
      "QUERY PLAN": Array<Record<string, unknown>>;
    }>(
      `
      EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
      SELECT id, email
      FROM subscribers
      WHERE verified_at IS NOT NULL
        AND unsubscribed_at IS NULL
        AND (
          welcome_email_status = 'failed'
          OR (
            welcome_email_status = 'claimed'
            AND welcome_email_claimed_at < CURRENT_TIMESTAMP
              - (${WELCOME_EMAIL_CLAIM_LEASE_MS} * interval '1 millisecond')
          )
        )
      ORDER BY welcome_email_claimed_at
      LIMIT ${50}
      `,
    );
    const plan = explainResult.rows[0]?.["QUERY PLAN"]?.[0];
    assert.ok(plan);
    const indexNames = new Set<string>();
    const nodeTypes: string[] = [];
    const visitPlan = (node: Record<string, unknown> | undefined): void => {
      if (!node) return;
      const rootPlan = node["Plan"];
      if (rootPlan && typeof rootPlan === "object") {
        visitPlan(rootPlan as Record<string, unknown>);
      }
      if (typeof node["Node Type"] === "string") {
        nodeTypes.push(node["Node Type"]);
      }
      if (typeof node["Index Name"] === "string") {
        indexNames.add(node["Index Name"]);
      }
      const children = node["Plans"];
      if (Array.isArray(children)) {
        for (const child of children) {
          if (child && typeof child === "object") {
            visitPlan(child as Record<string, unknown>);
          }
        }
      }
    };
    visitPlan(plan);
    const rootPlan = plan["Plan"];
    assert.ok(rootPlan && typeof rootPlan === "object");
    assert.equal((rootPlan as Record<string, unknown>)["Node Type"], "Limit");
    assert.equal(nodeTypes.includes("Seq Scan"), false);
    assert.equal(nodeTypes.includes("Sort"), false);
    assert.ok(
      indexNames.has("subscribers_welcome_recovery_idx"),
      `expected the recovery lookup to use subscribers_welcome_recovery_idx, got ${JSON.stringify(plan)}`,
    );
    assert.ok(
      nodeTypes.includes("Index Scan"),
      `expected an ordered index scan for the recovery lookup, got ${JSON.stringify(plan)}`,
    );
    assert.equal((rootPlan as Record<string, unknown>)["Actual Rows"], 50);

    const adminExplainResult = await client.query<{
      "QUERY PLAN": Array<Record<string, unknown>>;
    }>(
      `
      EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
      SELECT id, email
      FROM subscribers
      WHERE welcome_email_status IN ('claimed', 'failed', 'permanently_failed')
      ORDER BY id
      LIMIT ${50}
      `,
    );
    const adminPlan = adminExplainResult.rows[0]?.["QUERY PLAN"]?.[0];
    assert.ok(adminPlan);
    const adminIndexNames = new Set<string>();
    const adminNodeTypes: string[] = [];
    const visitAdminPlan = (node: Record<string, unknown> | undefined): void => {
      if (!node) return;
      const rootPlan = node["Plan"];
      if (rootPlan && typeof rootPlan === "object") {
        visitAdminPlan(rootPlan as Record<string, unknown>);
      }
      if (typeof node["Node Type"] === "string") {
        adminNodeTypes.push(node["Node Type"]);
      }
      if (typeof node["Index Name"] === "string") {
        adminIndexNames.add(node["Index Name"]);
      }
      const children = node["Plans"];
      if (Array.isArray(children)) {
        for (const child of children) {
          if (child && typeof child === "object") {
            visitAdminPlan(child as Record<string, unknown>);
          }
        }
      }
    };
    visitAdminPlan(adminPlan);
    const adminRootPlan = adminPlan["Plan"];
    assert.ok(adminRootPlan && typeof adminRootPlan === "object");
    assert.equal((adminRootPlan as Record<string, unknown>)["Node Type"], "Limit");
    assert.equal(adminNodeTypes.includes("Seq Scan"), false);
    assert.equal(adminNodeTypes.includes("Sort"), false);
    assert.ok(
      adminIndexNames.has("subscribers_welcome_admin_idx"),
      `expected the admin lookup to use subscribers_welcome_admin_idx, got ${JSON.stringify(adminPlan)}`,
    );
    assert.ok(
      adminNodeTypes.includes("Index Scan"),
      `expected an ordered index scan for the admin lookup, got ${JSON.stringify(adminPlan)}`,
    );
    assert.equal((adminRootPlan as Record<string, unknown>)["Actual Rows"], 50);

    const summaryExplainResult = await client.query<{
      "QUERY PLAN": Array<Record<string, unknown>>;
    }>(
      `
      EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
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
      `,
    );
    const summaryPlan = summaryExplainResult.rows[0]?.["QUERY PLAN"]?.[0];
    assert.ok(summaryPlan);
    const summaryIndexNames = new Set<string>();
    const summaryNodeTypes: string[] = [];
    const visitSummaryPlan = (node: Record<string, unknown> | undefined): void => {
      if (!node) return;
      const rootPlan = node["Plan"];
      if (rootPlan && typeof rootPlan === "object") {
        visitSummaryPlan(rootPlan as Record<string, unknown>);
      }
      if (typeof node["Node Type"] === "string") {
        summaryNodeTypes.push(node["Node Type"]);
      }
      if (typeof node["Index Name"] === "string") {
        summaryIndexNames.add(node["Index Name"]);
      }
      const children = node["Plans"];
      if (Array.isArray(children)) {
        for (const child of children) {
          if (child && typeof child === "object") {
            visitSummaryPlan(child as Record<string, unknown>);
          }
        }
      }
    };
    visitSummaryPlan(summaryPlan);
    assert.equal(
      summaryNodeTypes.includes("Seq Scan"),
      false,
      `expected indexed backlog summary access, got ${JSON.stringify(summaryPlan)}`,
    );
    assert.ok(
      summaryNodeTypes.some((nodeType) =>
        ["Index Scan", "Index Only Scan"].includes(nodeType),
      ),
      `expected an indexed backlog summary access, got ${JSON.stringify(summaryPlan)}`,
    );
    for (const expectedIndex of [
      "subscribers_welcome_failed_backlog_idx",
      "subscribers_welcome_expired_backlog_idx",
    ]) {
      assert.ok(
        summaryIndexNames.has(expectedIndex),
        `expected the backlog summary to use ${expectedIndex}, got ${JSON.stringify(summaryPlan)}`,
      );
    }
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
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

    await db
      .update(subscribersTable)
      .set({
        replacementVerificationRetryAt: sql`CURRENT_TIMESTAMP - interval '1 millisecond'`,
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