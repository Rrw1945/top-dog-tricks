import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { inArray } from "drizzle-orm";
import { createAdminCookie } from "../lib/adminSession";
import { db, pool, submissionsTable } from "@workspace/db";
import contestantsRouter, { escapeLike, parseContestantsQuery } from "./contestants";

after(async () => { await pool.end(); });

test("query rejects invalid paging and escapes SQL LIKE wildcards", () => {
  for (const query of [{ limit: "0" }, { limit: "101" }, { limit: "1.2" }, { cursor: "-1" }, { cursor: "0" }, { cursor: "999999999999999999999" }, { search: ["one", "two"] }, { limit: ["1", "2"] }, { other: "x" }]) {
    assert.equal(parseContestantsQuery(query), null);
  }
  assert.deepEqual(parseContestantsQuery({}), { search: "", limit: 50, cursor: undefined });
  assert.equal(escapeLike("x%_\\z"), "x\\%\\_\\\\z");
});

test("contacts require admin and paginate matching submissions, not unique owners", async () => {
  process.env.SESSION_SECRET ||= "contestants-integration-test-secret";
  const serverApp = express();
  serverApp.use("/api", contestantsRouter);
  const server = serverApp.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/contestants`;
  const cookie = createAdminCookie().split(";")[0]!;
  const token = crypto.randomUUID().slice(0, 8);
  const ids: number[] = [];
  const get = (query = "", authorized = true) => fetch(base + query, { headers: authorized ? { cookie } : {} });
  try {
    const denied = await get("", false);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("cache-control"), "private, no-store");
    for (const query of ["?limit=101", "?limit=1.2", "?cursor=0", "?limit=1&limit=2", "?search=a&search=b"]) {
      assert.equal((await get(query)).status, 400, query);
    }
    for (const dogName of ["Alpha", "Beta", "Gamma"]) {
      const [row] = await db.insert(submissionsTable).values({
        ownerName: `Test Owner %_${token}`,
        dogName,
        email: `test-${token}@example.invalid`,
        phone: "555-0100",
        trickName: "test",
        trickDescription: "test",
        videoObjectPath: `test/${token}`,
        videoFileName: "test.mp4",
        videoContentType: "video/mp4",
        signatureObjectPath: `test/${token}`,
      }).returning({ id: submissionsTable.id });
      ids.push(row!.id);
    }
    const search = `?search=${encodeURIComponent(`%_${token}`)}&limit=2`;
    const first = await (await get(search)).json() as { records: Array<Record<string, unknown>>; nextCursor: string };
    assert.equal(first.records.length, 2);
    assert.deepEqual(first.records.map((row) => row.id), ids.slice(1).reverse());
    assert.deepEqual(Object.keys(first.records[0]!).sort(), ["dogName", "email", "id", "ownerName", "phone", "status", "submittedAt"]);
    assert.equal(first.nextCursor, String(ids[1]));
    const second = await (await get(`${search}&cursor=${first.nextCursor}`)).json() as { records: Array<{ id: number }>; nextCursor: null };
    assert.deepEqual(second.records.map((row) => row.id), [ids[0]]);
    assert.equal(second.nextCursor, null);
    const wildcard = await (await get(`?search=${encodeURIComponent(`_${token}`)}`)).json() as { records: Array<{ id: number }> };
    assert.deepEqual(wildcard.records.map((row) => row.id), ids.slice().reverse());
  } finally {
    if (ids.length) await db.delete(submissionsTable).where(inArray(submissionsTable.id, ids));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});