import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

const COOKIE_NAME = "top_dog_admin";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function getSecret(): string {
  return process.env.SESSION_SECRET ?? "top-dog-tricks-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD ?? "topdog";
}

export function createAdminCookie(): string {
  const payload = Buffer.from(`${Date.now()}`, "utf8").toString("base64url");
  return `${COOKIE_NAME}=${payload}.${sign(payload)}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearAdminCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

function getCookieValue(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === COOKIE_NAME) return valueParts.join("=");
  }

  return undefined;
}

export function isAdminAuthenticated(req: Request): boolean {
  const value = getCookieValue(req);
  if (!value) return false;

  const [payload, providedSignature] = value.split(".");
  if (!payload || !providedSignature) return false;

  const expectedSignature = sign(payload);
  if (providedSignature.length !== expectedSignature.length) return false;

  const validSignature = timingSafeEqual(
    Buffer.from(providedSignature),
    Buffer.from(expectedSignature),
  );
  if (!validSignature) return false;

  const createdAt = Number(Buffer.from(payload, "base64url").toString("utf8"));
  if (!Number.isFinite(createdAt)) return false;

  return Date.now() - createdAt <= MAX_AGE_SECONDS * 1000;
}