import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import { db, pool, submissionsTable, videoLikesTable } from "@workspace/db";
import engagementRouter from "./engagement";

after(async () => { await pool.end(); });

for (const { status, processingStatus } of [
  { status: "pending", processingStatus: "completed" },
  { status: "rejected", processingStatus: "completed" },
  { status: "approved", processingStatus: "queued" },
] as const) {
  test(`showcase likes reject ${status}/${processingStatus} videos without storing likes`, async () => {
    const unique = crypto.randomUUID();
    const [submission] = await db.insert(submissionsTable).values({
      ownerName: "Hidden like regression fixture",
      email: `like-${unique}@example.com`,
      phone: "test",
      dogName: "Test",
      trickName: "Hidden like regression",
      trickDescription: "Integration fixture",
      videoObjectPath: `test/${unique}/video`,
      videoFileName: "video.mp4",
      videoContentType: "video/mp4",
      signatureObjectPath: `test/${unique}/signature`,
      status,
      processingStatus,
    }).returning({ id: submissionsTable.id });
    assert.ok(submission);
    const app = express();
    app.use(express.json());
    app.use("/api", engagementRouter);
    const server = app.listen(0);
    try {
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/showcase/${submission.id}/like`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ browserId: unique }),
        },
      );
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Approved video not found" });
      const likes = await db.select({ id: videoLikesTable.id })
        .from(videoLikesTable)
        .where(eq(videoLikesTable.submissionId, submission.id));
      assert.deepEqual(likes, [], "A hidden video must not receive any stored likes");
    } finally {
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()),
        );
      } finally {
        await db.delete(videoLikesTable).where(eq(videoLikesTable.submissionId, submission.id));
        await db.delete(submissionsTable).where(eq(submissionsTable.id, submission.id));
      }
    }
  });
}

test("showcase likes accept a browser ID, toggle, and reject unrelated email payloads", async () => {
  const unique = crypto.randomUUID();
  const [submission] = await db.insert(submissionsTable).values({
    ownerName: "Like regression fixture",
    email: `like-${unique}@example.com`,
    phone: "test",
    dogName: "Test",
    trickName: "Like regression",
    trickDescription: "Integration fixture",
    videoObjectPath: `test/${unique}/video`,
    videoFileName: "video.mp4",
    videoContentType: "video/mp4",
    signatureObjectPath: `test/${unique}/signature`,
    status: "approved",
    processingStatus: "completed",
  }).returning({ id: submissionsTable.id });
  assert.ok(submission);
  const app = express();
  app.use(express.json());
  app.use("/api", engagementRouter);
  const server = app.listen(0);
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/showcase/${submission.id}/like`;
    for (const liked of [true, false]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ browserId: unique }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        submissionId: submission.id, liked, likeCount: liked ? 1 : 0,
      });
    }
    const invalid = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "fixture@example.com" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await db.delete(videoLikesTable).where(eq(videoLikesTable.submissionId, submission.id));
    await db.delete(submissionsTable).where(eq(submissionsTable.id, submission.id));
  }
});
