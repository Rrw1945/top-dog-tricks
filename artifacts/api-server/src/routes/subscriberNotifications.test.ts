import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverSpotlightNotifications,
  isEligibleSpotlightSubscriber,
  SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS,
} from "./submissions";
import {
  createUnsubscribeToken,
  readUnsubscribeToken,
} from "../lib/subscriberTokens";
import {
  createInitialVerificationToken,
  createReplacementVerificationToken,
  getConfirmationCohort,
  readConfirmationCohort,
  readConfirmationTokenMetadata,
} from "../lib/subscriberTokens";

process.env.SESSION_SECRET = "subscriber-notification-test-secret";

test("only verified, non-unsubscribed subscribers are eligible", () => {
  assert.equal(
    isEligibleSpotlightSubscriber({
      verifiedAt: new Date(),
      unsubscribedAt: null,
    }),
    true,
  );
  assert.equal(
    isEligibleSpotlightSubscriber({
      verifiedAt: null,
      unsubscribedAt: null,
    }),
    false,
  );
  assert.equal(
    isEligibleSpotlightSubscriber({
      verifiedAt: new Date(),
      unsubscribedAt: new Date(),
    }),
    false,
  );
});

test("only eligible subscribers returned by the verified and active query are emailed", async () => {
  const sent: string[] = [];
  const eligible = [{ id: 1, email: "verified@example.com" }];

  await deliverSpotlightNotifications(
    { id: 42, trickName: "Perfect rollover" },
    "https://example.com",
    () => assert.fail("notification should not fail"),
    {
      listEligibleSubscribers: async () => eligible,
      claimDelivery: async () => 1,
      markDelivered: async () => {},
      markFailed: async () => {},
      sendNotification: async (email) => {
        sent.push(email);
      },
      createToken: createUnsubscribeToken,
    },
  );

  assert.deepEqual(sent, ["verified@example.com"]);
});

test("a previously claimed video delivery is not sent twice", async () => {
  const deliveries = new Map<string, "claimed" | "delivered" | "failed">();
  let sends = 0;
  const dependencies = {
    listEligibleSubscribers: async () => [{ id: 7, email: "dog@example.com" }],
    claimDelivery: async (submissionId: number, subscriberId: number) => {
      const key = `${submissionId}:${subscriberId}`;
      if (deliveries.has(key)) return null;
      deliveries.set(key, "claimed");
      return 1;
    },
    markDelivered: async () => {
      deliveries.set("99:7", "delivered");
    },
    markFailed: async () => {},
    sendNotification: async () => {
      sends += 1;
    },
    createToken: createUnsubscribeToken,
  };

  const submission = { id: 99, trickName: "Backflip" };
  await deliverSpotlightNotifications(
    submission,
    "https://example.com",
    () => assert.fail("notification should not fail"),
    dependencies,
  );
  await deliverSpotlightNotifications(
    submission,
    "https://example.com",
    () => assert.fail("notification should not fail"),
    dependencies,
  );

  assert.equal(sends, 1);
});

test("signed unsubscribe links accept valid tokens and reject tampering", () => {
  const token = createUnsubscribeToken(123);

  assert.equal(readUnsubscribeToken(token), 123);
  assert.equal(readUnsubscribeToken(`124.${token.split(".")[1]}`), null);
  assert.equal(readUnsubscribeToken(`${token}x`), null);
});

test("confirmation tokens retain only a fixed calendar cohort marker", () => {
  const cohort = getConfirmationCohort(new Date("2026-09-09T12:00:00Z"));
  const initialToken = createInitialVerificationToken("initial-random", new Date("2026-09-09T12:00:00Z"));
  const replacementToken = createReplacementVerificationToken(
    123,
    `${cohort}~replacement-attempt`,
  );

  assert.equal(readConfirmationCohort(initialToken), cohort);
  assert.equal(readConfirmationCohort(replacementToken), cohort);
  assert.equal(readConfirmationCohort("legacy-random-token"), null);
  assert.equal(readConfirmationCohort("2026-09-09~not-a-cohort"), null);
  assert.deepEqual(readConfirmationTokenMetadata(initialToken), {
    source: "initial",
    cohort,
    history: "native",
  });
  assert.deepEqual(readConfirmationTokenMetadata(replacementToken), {
    source: "replacement",
    cohort,
    history: "native",
  });
  assert.deepEqual(readConfirmationTokenMetadata("legacy-random-token"), {
    source: "initial",
    cohort: null,
    history: "legacy",
  });
});

test("confirmation cohorts use UTC Monday boundaries rather than local device time", () => {
  assert.equal(
    getConfirmationCohort(new Date("2026-09-06T23:59:59.999Z")),
    "2026-08-31",
  );
  assert.equal(
    getConfirmationCohort(new Date("2026-09-07T00:00:00.000Z")),
    "2026-09-07",
  );
  assert.equal(
    getConfirmationCohort(new Date("2026-09-13T23:59:59.999Z")),
    "2026-09-07",
  );
  assert.equal(
    getConfirmationCohort(new Date("2026-09-14T00:00:00.000Z")),
    "2026-09-14",
  );
});

test("email failures are logged and do not alter the completed submission", async () => {
  const completedSubmission = {
    id: 55,
    trickName: "High five",
    processingStatus: "completed",
  } as const;
  const failures: Array<{ error: unknown; subscriberId?: number }> = [];

  await deliverSpotlightNotifications(
    completedSubmission,
    "https://example.com",
    (error, subscriberId) => failures.push({ error, subscriberId }),
    {
      listEligibleSubscribers: async () => [
        { id: 3, email: "subscriber@example.com" },
      ],
      claimDelivery: async () => 1,
      markDelivered: async () => {},
      markFailed: async () => {},
      sendNotification: async () => {
        throw new Error("Resend unavailable");
      },
      createToken: createUnsubscribeToken,
    },
  );

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.subscriberId, 3);
  assert.match(String(failures[0]?.error), /Resend unavailable/);
  assert.equal(completedSubmission.processingStatus, "completed");
});

test("a failed delivery can be retried without resending delivered notifications", async () => {
  let state: "missing" | "claimed" | "failed" | "delivered" = "missing";
  let sends = 0;
  const idempotencyKeys: string[] = [];
  const dependencies = {
    listEligibleSubscribers: async () => [{ id: 8, email: "retry@example.com" }],
    claimDelivery: async () => {
      if (state === "claimed" || state === "delivered") return null;
      state = "claimed";
      return 10;
    },
    markDelivered: async () => {
      state = "delivered";
    },
    markFailed: async () => {
      state = "failed";
    },
    sendNotification: async (_email: string, _trickName: string, _spotlightUrl: string, _unsubscribeUrl: string, idempotencyKey: string) => {
      sends += 1;
      idempotencyKeys.push(idempotencyKey);
      if (sends === 1) throw new Error("temporary Resend failure");
    },
    createToken: createUnsubscribeToken,
  };
  const submission = { id: 100, trickName: "Retry roll" };
  const failures: unknown[] = [];

  await deliverSpotlightNotifications(
    submission,
    "https://example.com",
    (error) => failures.push(error),
    dependencies,
  );
  await deliverSpotlightNotifications(
    submission,
    "https://example.com",
    (error) => failures.push(error),
    dependencies,
  );
  await deliverSpotlightNotifications(
    submission,
    "https://example.com",
    (error) => failures.push(error),
    dependencies,
  );

  assert.equal(sends, 2);
  assert.equal(state, "delivered");
  assert.equal(failures.length, 1);
  assert.deepEqual(idempotencyKeys, [
    "spotlight-notification-10",
    "spotlight-notification-10",
  ]);
});

test("concurrent workers cannot both claim the same failed delivery", async () => {
  let state: "failed" | "claimed" = "failed";
  let sends = 0;
  const dependencies = {
    listEligibleSubscribers: async () => [{ id: 9, email: "race@example.com" }],
    claimDelivery: async () => {
      if (state !== "failed") return null;
      state = "claimed";
      return 11;
    },
    markDelivered: async () => {},
    markFailed: async () => {},
    sendNotification: async () => {
      sends += 1;
    },
    createToken: createUnsubscribeToken,
  };

  await Promise.all([
    deliverSpotlightNotifications(
      { id: 101, trickName: "Race-free roll" },
      "https://example.com",
      () => assert.fail("notification should not fail"),
      dependencies,
    ),
    deliverSpotlightNotifications(
      { id: 101, trickName: "Race-free roll" },
      "https://example.com",
      () => assert.fail("notification should not fail"),
      dependencies,
    ),
  ]);

  assert.equal(sends, 1);
});

test("an active claim cannot be reclaimed before its lease expires", async () => {
  const claimedAt = new Date();
  let sends = 0;
  const dependencies = {
    listEligibleSubscribers: async () => [{ id: 11, email: "active@example.com" }],
    claimDelivery: async () =>
      Date.now() - claimedAt.getTime() > SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS
        ? 13
        : null,
    markDelivered: async () => {},
    markFailed: async () => {},
    sendNotification: async () => {
      sends += 1;
    },
    createToken: createUnsubscribeToken,
  };

  await deliverSpotlightNotifications(
    { id: 103, trickName: "Active claim" },
    "https://example.com",
    () => assert.fail("notification should not fail"),
    dependencies,
  );

  assert.equal(sends, 0);
});

test("only one concurrent worker can reclaim an expired claim", async () => {
  let status: "claimed" | "delivered" = "claimed";
  let claimedAt = new Date(
    Date.now() - SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS - 1,
  );
  let sends = 0;
  const dependencies = {
    listEligibleSubscribers: async () => [{ id: 12, email: "stale@example.com" }],
    claimDelivery: async () => {
      if (
        status !== "claimed" ||
        Date.now() - claimedAt.getTime() <=
          SPOTLIGHT_NOTIFICATION_CLAIM_LEASE_MS
      ) {
        return null;
      }
      claimedAt = new Date();
      return 14;
    },
    markDelivered: async () => {
      status = "delivered";
    },
    markFailed: async () => {},
    sendNotification: async () => {
      sends += 1;
    },
    createToken: createUnsubscribeToken,
  };

  await Promise.all([
    deliverSpotlightNotifications(
      { id: 104, trickName: "Stale claim" },
      "https://example.com",
      () => assert.fail("notification should not fail"),
      dependencies,
    ),
    deliverSpotlightNotifications(
      { id: 104, trickName: "Stale claim" },
      "https://example.com",
      () => assert.fail("notification should not fail"),
      dependencies,
    ),
  ]);

  assert.equal(sends, 1);
  assert.equal(status, "delivered");
});

test("a database failure after provider acceptance retries with the same idempotency key", async () => {
  let state: "missing" | "claimed" | "failed" | "delivered" = "missing";
  let completionAttempts = 0;
  const providerRequests: string[] = [];
  const dependencies = {
    listEligibleSubscribers: async () => [
      { id: 10, email: "accepted@example.com" },
    ],
    claimDelivery: async () => {
      if (state === "claimed" || state === "delivered") return null;
      state = "claimed";
      return 12;
    },
    markDelivered: async () => {
      completionAttempts += 1;
      if (completionAttempts === 1) {
        throw new Error("database temporarily unavailable");
      }
      state = "delivered";
    },
    markFailed: async () => {
      state = "failed";
    },
    sendNotification: async (
      _email: string,
      _trickName: string,
      _spotlightUrl: string,
      _unsubscribeUrl: string,
      idempotencyKey: string,
    ) => {
      providerRequests.push(idempotencyKey);
    },
    createToken: createUnsubscribeToken,
  };

  await deliverSpotlightNotifications(
    { id: 102, trickName: "Database-safe roll" },
    "https://example.com",
    () => {},
    dependencies,
  );
  await deliverSpotlightNotifications(
    { id: 102, trickName: "Database-safe roll" },
    "https://example.com",
    () => {},
    dependencies,
  );

  assert.equal(state, "delivered");
  assert.equal(completionAttempts, 2);
  assert.deepEqual(providerRequests, [
    "spotlight-notification-12",
    "spotlight-notification-12",
  ]);
});