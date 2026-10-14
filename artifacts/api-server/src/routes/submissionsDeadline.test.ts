import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";

test("actual submission route rejects late requests before insertion and leaves admin routes ungated", async (t) => {
  const { default: submissionsRouter } = await import("./submissions");
  const { db, pool } = await import("@workspace/db");
  const insert = t.mock.method(db, "insert", () => {
    throw new Error("A closed contest must never insert an entry");
  });
  const app = express();
  app.use(express.json());
  app.use("/api", submissionsRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/submissions`;
  try {
    const now = t.mock.method(Date, "now", () => Date.parse("2027-01-01T06:59:59.999Z"));
    const send = (body: object) => fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // Before cutoff, validation is reached (not a closed-contest response).
    assert.equal((await send({})).status, 400);
    now.mock.mockImplementation(() => Date.parse("2027-01-01T07:00:00Z"));
    const response = await send({
      ownerName: "Test entrant", email: "test@example.invalid", dogName: "Test dog",
      trickDescription: "A trick", videoObjectPath: "/objects/test",
      videoFileName: "test.mp4", videoContentType: "video/mp4", signatureObjectPath: "/objects/signature",
      // A forged earlier timestamp cannot bypass server time.
      submittedAt: "2026-10-01T00:00:00Z",
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { code: string }).code, "CONTEST_CLOSED");
    assert.equal((await send({})).status, 403);
    assert.equal(insert.mock.callCount(), 0);
    // Review paths still use their normal admin authentication, not the cutoff.
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(`${base}/1`)).status, 401);
    assert.equal((await fetch(`${base}/1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  } finally {
    t.mock.restoreAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});
