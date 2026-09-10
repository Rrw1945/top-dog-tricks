import { createHmac, timingSafeEqual } from "node:crypto";

const CONFIRMATION_COHORT_DAYS = 7;
const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const COHORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ConfirmationTokenMetadata = {
  source: "initial" | "replacement";
  cohort: string | null;
  history: "native" | "legacy";
};

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to sign unsubscribe links");
  }
  return secret;
}

function signature(subscriberId: number): string {
  return createHmac("sha256", signingSecret())
    .update(String(subscriberId))
    .digest("base64url");
}

export function getConfirmationCohort(date = new Date()): string {
  const daysSinceMonday = (date.getUTCDay() + 6) % CONFIRMATION_COHORT_DAYS;
  const cohortStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      - daysSinceMonday * UTC_DAY_MS,
  );
  return cohortStart.toISOString().slice(0, 10);
}

export function createInitialVerificationToken(
  randomToken: string,
  date = new Date(),
): string {
  return `${getConfirmationCohort(date)}~${randomToken}`;
}

export function createReplacementVerificationToken(
  subscriberId: number,
  attemptId: string,
): string {
  return `${attemptId}.${createHmac("sha256", signingSecret())
    .update(`subscriber-verification:${subscriberId}:${attemptId}`)
    .digest("base64url")}`;
}

export function readConfirmationCohort(value: string): string | null {
  const [cohort] = value.split("~", 1);
  if (!cohort || !COHORT_DATE_PATTERN.test(cohort)) return null;
  const parsed = new Date(`${cohort}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && getConfirmationCohort(parsed) === cohort
    ? cohort
    : null;
}

export function readConfirmationTokenMetadata(
  value: string,
): ConfirmationTokenMetadata {
  const cohort = readConfirmationCohort(value);
  return {
    source: value.includes(".") ? "replacement" : "initial",
    cohort,
    history: cohort ? "native" : "legacy",
  };
}

export function createUnsubscribeToken(subscriberId: number): string {
  return `${subscriberId}.${signature(subscriberId)}`;
}

export function readUnsubscribeToken(value: string): number | null {
  const [rawId, suppliedSignature, extra] = value.split(".");
  if (!rawId || !suppliedSignature || extra !== undefined) return null;

  const subscriberId = Number(rawId);
  if (!Number.isSafeInteger(subscriberId) || subscriberId <= 0) return null;

  const expected = Buffer.from(signature(subscriberId));
  const supplied = Buffer.from(suppliedSignature);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return null;
  }
  return subscriberId;
}