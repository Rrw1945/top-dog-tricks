import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { it } from "node:test";
import { createAdminCookie, getAdminPassword, isAdminAuthenticated } from "./adminSession";
import type { Request } from "express";

it("fails closed without a signing secret and refuses malformed or future cookies", () => {
  const previous = process.env.SESSION_SECRET;
  const previousMode = process.env.NODE_ENV;
  const request = (cookie: string) => ({ headers: { cookie } }) as Request;
  try {
    delete process.env.SESSION_SECRET;
    assert.equal(isAdminAuthenticated(request("")), false);
    assert.throws(() => createAdminCookie(), /SESSION_SECRET/);
    process.env.SESSION_SECRET = "admin-session-test-secret";
    process.env.NODE_ENV = "production";
    const cookie = createAdminCookie();
    assert.match(cookie, /; Secure$/);
    const value = cookie.split(";")[0]!;
    assert.equal(isAdminAuthenticated(request(value)), true);
    assert.equal(isAdminAuthenticated(request(`${value}.extra`)), false);
    assert.equal(isAdminAuthenticated(request(value.replace(/.$/, "x"))), false);
    for (const timestamp of [Date.now() + 60_000, Date.now() - 8 * 24 * 60 * 60 * 1000, -1]) {
      const payload = Buffer.from(String(timestamp)).toString("base64url");
      const signature = createHmac("sha256", "admin-session-test-secret").update(payload).digest("hex");
      assert.equal(isAdminAuthenticated(request(`top_dog_admin=${payload}.${signature}`)), false);
    }
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
  }
});

it("does not supply a default admin password when configuration is absent", () => {
  assert.equal(getAdminPassword({}), undefined);
});

it("disables login for empty and whitespace-only configuration", () => {
  for (const password of ["", " ", "\t\n"]) {
    assert.equal(getAdminPassword({ ADMIN_PASSWORD: password }), undefined);
  }
});

it("uses the explicitly configured password without altering it", () => {
  const password = "test-only-long-password-42!";
  assert.equal(getAdminPassword({ ADMIN_PASSWORD: password }), password);
  assert.equal(getAdminPassword({ ADMIN_PASSWORD: ` ${password} ` }), ` ${password} `);
});