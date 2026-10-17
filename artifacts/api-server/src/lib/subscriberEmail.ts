import { ReplitConnectors } from "@replit/connectors-sdk";

import type { AnalyticsCoverageRegressionNotification } from "./integrations";

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "Top Dog Tricks <hello@topdogtricks.com>";

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

export type EmailDeliveryFailureClassification =
  | "retryable_provider_failure"
  | "permanent_provider_failure"
  | "unexpected_failure";
export function createSubscriptionWelcomeIdempotencyKey(
  subscriberId: number,
): string {
  return `subscriber-welcome-${subscriberId}`;
}

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  idempotencyKey?: string,
): Promise<void> {
  const response = await new ReplitConnectors().proxy("resend", "/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: { from: FROM_EMAIL, to: [to], subject, html },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new EmailDeliveryError(
      `Resend request failed (${response.status}): ${text.slice(0, 300)}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
}

function emailFrame(
  content: string,
  footer = "You received this because you asked for Top Dog Tricks updates.",
): string {
  return `<div style="background:#f7f7f2;padding:32px;font-family:Arial,sans-serif;color:#10182b"><div style="max-width:560px;margin:auto;background:#fff;border-radius:24px;padding:32px;border:1px solid #e4e4dc"><div style="font-weight:900;letter-spacing:.08em;color:#ff4b00">TOP DOG TRICKS</div>${content}<p style="margin-top:30px;font-size:12px;color:#697080">${footer}</p></div></div>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export async function sendSubmissionReceipt(
  submission: { id: number; email: string; ownerName: string; dogName: string },
  publicBaseUrl: string,
): Promise<void> {
  const ownerName = escapeHtml(submission.ownerName);
  const dogName = escapeHtml(submission.dogName);
  const newsletterUrl = escapeHtml(`${publicBaseUrl}/#newsletter`);
  await sendEmail(
    submission.email,
    "We received your Top Dog Tricks entry",
    emailFrame(
      `<h1 style="font-size:30px;margin:24px 0 12px">Thanks for sharing ${dogName} with us!</h1><p style="line-height:1.6">Hi ${ownerName},</p><p style="line-height:1.6">We received your video of ${dogName}. Your entry is awaiting review; it has not been accepted or published.</p><p style="line-height:1.6">Want new tricks and contest updates by email? Use the button below to open our signup form.</p><a href="${newsletterUrl}" style="display:inline-block;margin-top:18px;background:#ff4b00;color:#fff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:12px">Subscribe to Top Dog Tricks</a>`,
      "You received this email because you submitted a video to Top Dog Tricks. This receipt does not subscribe you to email updates.",
    ),
    `submission-receipt-${submission.id}`,
  );
}

export async function sendSubscriptionConfirmation(
  email: string,
  verifyUrl: string,
  idempotencyKey?: string,
): Promise<void> {
  await sendEmail(
    email,
    "Confirm your Top Dog Tricks subscription",
    emailFrame(`<h1 style="font-size:30px;margin:24px 0 12px">One quick confirmation.</h1><p style="line-height:1.6">Click below to get new tricks and contest updates. You won’t be subscribed until you confirm.</p><a href="${verifyUrl}" style="display:inline-block;margin-top:18px;background:#ff4b00;color:#fff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:12px">Confirm subscription</a>`),
    idempotencyKey,
  );
}

export async function sendSubscriptionWelcome(
  email: string,
  unsubscribeUrl: string,
  idempotencyKey?: string,
): Promise<void> {
  await sendEmail(
    email,
    "You’re on the Top Dog Tricks list",
    emailFrame(`<h1 style="font-size:30px;margin:24px 0 12px">Welcome to the pack.</h1><p style="line-height:1.6">You’ll hear from us when new tricks hit the spotlight or a new contest opens.</p><p style="margin-top:24px;font-size:12px"><a href="${unsubscribeUrl}" style="color:#697080">Unsubscribe anytime</a></p>`),
    idempotencyKey,
  );
}

export async function sendSpotlightNotification(
  email: string,
  trickName: string,
  spotlightUrl: string,
  unsubscribeUrl: string,
  idempotencyKey: string,
): Promise<void> {
  const safeTrickName = escapeHtml(trickName);
  const subjectTrickName = trickName.replace(/[\r\n]+/g, " ").trim();
  await sendEmail(
    email,
    `${subjectTrickName} just reached the spotlight`,
    emailFrame(`<h1 style="font-size:30px;margin:24px 0 12px">A new trick is in the spotlight.</h1><p style="line-height:1.6"><strong>${safeTrickName}</strong> is ready to watch.</p><a href="${spotlightUrl}" style="display:inline-block;margin-top:18px;background:#ff4b00;color:#fff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:12px">Watch the trick</a><p style="margin-top:24px;font-size:12px"><a href="${unsubscribeUrl}" style="color:#697080">Unsubscribe anytime</a></p>`),
    idempotencyKey,
  );
}

export async function sendAnalyticsCoverageRegressionEmail(
  notification: AnalyticsCoverageRegressionNotification,
  idempotencyKey: string,
): Promise<void> {
  const to = process.env.ANALYTICS_COVERAGE_ALERT_EMAIL?.trim();
  if (!to) {
    throw new Error(
      "ANALYTICS_COVERAGE_ALERT_EMAIL is required for the analytics coverage email fallback",
    );
  }

  const cohortRows = notification.cohorts
    .map(
      ({ cohort, requests }) =>
        `<li><strong>${escapeHtml(cohort)}</strong>: ${requests} native requests</li>`,
    )
    .join("");
  await sendEmail(
    to,
    "Analytics coverage regression detected",
    emailFrame(
      `<h1 style="font-size:26px;margin:24px 0 12px">Analytics coverage regression detected</h1><p>Covered cohorts stopped producing native events:</p><ul>${cohortRows}</ul>`,
      "Automated operator alert for newsletter analytics coverage.",
    ),
    idempotencyKey,
  );
}

export function classifyEmailDeliveryFailure(
  error: unknown,
): EmailDeliveryFailureClassification {
  if (!(error instanceof EmailDeliveryError)) return "unexpected_failure";
  return error.retryable
    ? "retryable_provider_failure"
    : "permanent_provider_failure";
}
