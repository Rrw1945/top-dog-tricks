import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { db, pool, submissionsTable } from "@workspace/db";
import { createAdminCookie } from "../lib/adminSession";
import { listReviewQueue, parseReviewQueueQuery } from "./reviewQueue";

after(async () => { await pool.end(); });

test("review queue validates bounded paging and scalar filters", () => {
  for (const query of [
    { limit: "0" }, { limit: "101" }, { limit: "1.5" }, { limit: "01" },
    { cursor: "-1" }, { cursor: "2147483648" }, { cursor: "1e2" },
    { search: ["one", "two"] }, { search: "a".repeat(201) },
    { status: "unknown" }, { status: ["pending", "approved"] }, { extra: "x" },
    { category: "unknown" }, { category: ["contest", "just_for_fun"] },
  ]) assert.equal(parseReviewQueueQuery(query), null);
  assert.equal(parseReviewQueueQuery({})?.limit, 50);
});

test("review queue searches beyond page one and keeps ID boundaries across status edits", async () => {
  process.env.SESSION_SECRET ||= "review-queue-integration-test-secret";
  const app = express();
  app.get("/api/submissions", listReviewQueue);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/submissions`;
  const cookie = createAdminCookie().split(";")[0]!;
  const token = `Queue%_\\${crypto.randomUUID()}`;
  const ids: number[] = [];
  type Page = { records: Array<{ id: number; dogName: string; status: string }>; nextCursor: number | null };
  const get = (query = "", authorized = true) => fetch(base + query, { headers: authorized ? { cookie } : {} });
  const page = async (query: string): Promise<Page> => {
    const response = await get(query);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return response.json() as Promise<Page>;
  };
  try {
    const denied = await get("", false);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("cache-control"), "private, no-store");
    for (const query of ["?limit=101", "?cursor=0", "?search=a&search=b", "?limit=2&limit=3"]) {
      assert.equal((await get(query)).status, 400);
    }
    const noSelect = mock.method(db, "select", () => { throw new Error("Short search must not query the archive"); });
    try {
      for (const term of ["x", "zx", " Zx ", "%", "_", "\\", "😀", "😀😀"]) {
        const response = await get(`?search=${encodeURIComponent(term)}&status=approved&cursor=100&category=contest`);
        assert.equal(response.status, 400);
        const body = await response.json() as { error: string };
        assert.match(body.error, /at least 3 characters/);
      }
      assert.equal(noSelect.mock.callCount(), 0);
    } finally {
      noSelect.mock.restore();
    }
    assert.equal((await get("?search=%20%20")).status, 200);
    for (let i = 0; i < 55; i++) {
      const [row] = await db.insert(submissionsTable).values({
        ownerName: token, dogName: i === 0 ? `Oldest ${token}` : `Dog ${i}`,
        email: "queue-test@example.invalid", phone: "555-0100",
        trickName: i === 0 ? `Rare Trick ${token}` : "Test trick",
        trickDescription: "Private description", videoObjectPath: "test/queue-private",
        videoFileName: "private.mp4", videoContentType: "video/mp4", signatureObjectPath: "test/private-signature",
      }).returning({ id: submissionsTable.id });
      ids.push(row!.id);
    }
    const search = `?search=${encodeURIComponent(token)}`;
    const first = await page(search);
    assert.equal(first.records.length, 50);
    assert.deepEqual(first.records.map((row) => row.id), ids.slice(5).reverse());
    assert.deepEqual(Object.keys(first.records[0]!).sort(), ["dogName", "id", "ownerName", "status", "trickName"]);
    const second = await page(`${search}&cursor=${first.nextCursor}`);
    assert.deepEqual(second.records.map((row) => row.id), ids.slice(0, 5).reverse());
    assert.equal(second.nextCursor, null);
    for (const term of [`oldest ${token}`, `rare trick ${token}`]) {
      assert.deepEqual((await page(`?search=${encodeURIComponent(term)}`)).records.map((row) => row.id), [ids[0]]);
    }
    assert.deepEqual((await page(`?search=${encodeURIComponent(`  ${token.toUpperCase()}  `)}`)).records.map(row => row.id), first.records.map(row => row.id));
    // Wildcard-looking characters remain literals, not SQL wildcards.
    assert.deepEqual((await page(`?search=${encodeURIComponent(token.replace("%_", "XY"))}`)).records, []);
    const pending = `${search}&status=pending&limit=2`;
    const before = await page(pending);
    // Removing both a previously seen row and the cursor row must not skip
    // the first unseen row (as offset pagination would).
    await db.update(submissionsTable).set({ status: "approved" })
      .where(inArray(submissionsTable.id, [ids[54]!, ids[53]!]));
    const afterEdit = await page(`${pending}&cursor=${before.nextCursor}`);
    assert.deepEqual(afterEdit.records.map((row) => row.id), [ids[52], ids[51]]);
    await db.update(submissionsTable).set({ status: "needs_edit" }).where(eq(submissionsTable.id, ids[51]!));
    const next = await page(`${pending}&cursor=${afterEdit.nextCursor}`);
    assert.deepEqual(next.records.map((row) => row.id), [ids[50], ids[49]]);
    const seen = [...before.records, ...afterEdit.records, ...next.records].map((row) => row.id);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual((await page(`${search}&status=approved`)).records.map((row) => row.id), [ids[54], ids[53]]);
    // Going back re-queries the current status rather than returning a stale page.
    assert.deepEqual((await page(pending)).records.map((row) => row.id), [ids[52], ids[50]]);
    // Contest review must fail closed for both fun and unclassified records.
    await db.update(submissionsTable).set({ category: "contest" }).where(eq(submissionsTable.id, ids[0]!));
    await db.update(submissionsTable).set({ category: "just_for_fun" }).where(eq(submissionsTable.id, ids[1]!));
    assert.deepEqual((await page(`${search}&category=contest`)).records.map(row => row.id), [ids[0]]);
    assert.deepEqual((await page(`${search}&category=just_for_fun`)).records.map(row => row.id), [ids[1]]);
    await db.update(submissionsTable).set({ category: "just_for_fun" }).where(eq(submissionsTable.id, ids[0]!));
    assert.deepEqual((await page(`${search}&category=contest`)).records, []);
  } finally {
    if (ids.length) await db.delete(submissionsTable).where(inArray(submissionsTable.id, ids));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
