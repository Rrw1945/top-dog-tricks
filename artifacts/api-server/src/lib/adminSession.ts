import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

const COOKIE_NAME = "top_dog_admin";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret?.trim()) throw new Error("SESSION_SECRET must be configured");
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export function getAdminPassword(
  environment: { ADMIN_PASSWORD?: string } = process.env,
): string | undefined {
  const password = environment.ADMIN_PASSWORD;
  return password?.trim() ? password : undefined;
}

export function createAdminCookie(): string {
  const payload = Buffer.from(`${Date.now()}`, "utf8").toString("base64url");
  return `${COOKIE_NAME}=${payload}.${sign(payload)}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function clearAdminCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
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
  if (!process.env.SESSION_SECRET?.trim()) return false;
  const value = getCookieValue(req);
  if (!value) return false;

  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [payload, providedSignature] = parts;
  if (!payload || !providedSignature || !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[a-f0-9]{64}$/.test(providedSignature)) return false;

  const expectedSignature = sign(payload);
  if (providedSignature.length !== expectedSignature.length) return false;

  const validSignature = timingSafeEqual(
    Buffer.from(providedSignature),
    Buffer.from(expectedSignature),
  );
  if (!validSignature) return false;

  const createdAt = Number(Buffer.from(payload, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > Date.now()) return false;

  return Date.now() - createdAt <= MAX_AGE_SECONDS * 1000;
}