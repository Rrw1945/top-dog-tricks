import { ReplitConnectors } from "@replit/connectors-sdk";

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

function emailFrame(content: string): string {
  return `<div style="background:#f7f7f2;padding:32px;font-family:Arial,sans-serif;color:#10182b"><div style="max-width:560px;margin:auto;background:#fff;border-radius:24px;padding:32px;border:1px solid #e4e4dc"><div style="font-weight:900;letter-spacing:.08em;color:#ff4b00">TOP DOG TRICKS</div>${content}<p style="margin-top:30px;font-size:12px;color:#697080">You received this because you asked for Top Dog Tricks updates.</p></div></div>`;
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