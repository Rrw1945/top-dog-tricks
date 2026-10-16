import assert from "node:assert/strict";
import { test, mock } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { createAdminCookie } from "../lib/adminSession";
import { ObjectStorageService, objectStorageClient } from "../lib/objectStorage";
import storageRouter, { canonicalStoragePath } from "./storage";
import submissionsRouter from "./submissions";

test("canonical storage paths reject traversal, encodings and cross-namespace aliases", () => {
  const path = (originalUrl: string, prefix = "objects") =>
    canonicalStoragePath({ originalUrl } as any, prefix);
  assert.equal(path("/api/storage/objects/uploads/abc"), "uploads/abc");
  assert.equal(path("/api/storage/objects/objects/automation/abc"), "objects/automation/abc");
  for (const bad of [
    "/api/storage/objects/../private",
    "/api/storage/objects/%2e%2e/private",
    "/api/storage/objects/automation%2fabc",
    "/api/storage/objects//abc",
    "/api/storage/objects/a\\b",
    "/api/storage/public-objects/../objects/automation/abc",
  ]) assert.equal(path(bad), null, bad);
});

test("public search cannot read objects under the private prefix even when search paths overlap", async () => {
  const oldPrivate = process.env.PRIVATE_OBJECT_DIR;
  const oldPublic = process.env.PUBLIC_OBJECT_SEARCH_PATHS;
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  process.env.PUBLIC_OBJECT_SEARCH_PATHS = "/test-bucket,/test-bucket/private";
  const bucket = mock.method(objectStorageClient, "bucket", () => {
    throw new Error("Private object storage must not be queried");
  });
  try {
    assert.equal(await new ObjectStorageService().searchPublicObject("private/uploads/original"), null);
    assert.equal(await new ObjectStorageService().searchPublicObject("../private/uploads/original"), null);
    assert.equal(bucket.mock.callCount(), 0);
  } finally {
    bucket.mock.restore();
    if (oldPrivate === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = oldPrivate;
    if (oldPublic === undefined) delete process.env.PUBLIC_OBJECT_SEARCH_PATHS;
    else process.env.PUBLIC_OBJECT_SEARCH_PATHS = oldPublic;
  }
});

test("external attachment read grants are short-lived storage URLs, not admin API URLs", async () => {
  const getFile = mock.method(ObjectStorageService.prototype, "getObjectEntityFile",
    async () => ({ bucket: { name: "test-bucket" }, name: "private/uploads/source" }) as any);
  const sign = mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.bucket_name, "test-bucket");
    assert.equal(body.object_name, "private/uploads/source");
    assert.equal(body.method, "GET");
    assert.ok(Date.parse(body.expires_at) - Date.now() <= 900_000);
    assert.ok(Date.parse(body.expires_at) > Date.now());
    return Response.json({ signed_url: "https://storage.googleapis.com/signed-test" });
  });
  try {
    assert.equal(await new ObjectStorageService().getObjectEntityReadURL("/objects/uploads/source"),
      "https://storage.googleapis.com/signed-test");
  } finally {
    getFile.mock.restore();
    sign.mock.restore();
  }
});

test("Showcase DTO exposes only playable processed paths and omits raw, signature and voiceover aliases", async () => {
  let calls = 0;
  const select = mock.method(db, "select", (columns: Record<string, unknown>) => {
    const call = calls++;
    if (call === 0) {
      assert.ok(!("videoObjectPath" in columns));
      assert.ok(!("voiceoverObjectPath" in columns));
    }
    const candidate = (id: number, processedVideoObjectPath: string) => ({
      id, dogName: "Dog", breedBio: null, trickName: "Trick",
      trickDescription: "Description", processedVideoObjectPath,
      punchline: null, publishedAt: new Date(),
      // Deliberate sensitive fields must not escape even if returned by a mock.
      videoObjectPath: "/objects/uploads/raw", voiceoverObjectPath: "/objects/automation/audio",
    });
    return {
      from: () => ({
        where: (predicate: SQL) => ({
          orderBy: async () => [candidate(1, "/objects/automation/processed"),
            candidate(2, "/objects/automation/audio")],
          then: (resolve: (rows: unknown[]) => unknown) => {
            if (call === 1) {
              const query = new PgDialect().sqlToQuery(predicate);
              assert.match(query.sql, /voiceover_object_path/);
              assert.ok(query.params.includes("/objects/automation/audio"));
              return resolve([{ videoObjectPath: "/objects/uploads/raw",
                signatureObjectPath: "/objects/uploads/signature",
                voiceoverObjectPath: "/objects/automation/audio" }]);
            }
            return resolve([]);
          },
          groupBy: async () => [],
        }),
      }),
    } as any;
  });
  const app = express();
  app.use("/api", submissionsRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/showcase`);
    assert.equal(response.status, 200);
    const entries = await response.json() as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.videoObjectPath, "/objects/automation/processed");
    assert.equal(entries[0]?.processedVideoObjectPath, "/objects/automation/processed");
    assert.ok(!("voiceoverObjectPath" in entries[0]!));
    assert.ok(!JSON.stringify(entries).includes("/objects/uploads/"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    select.mock.restore();
  }
});

test("private media requires a signed admin session; only live processed media is public", async () => {
  const oldSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "storage-route-test-secret";
  const admin = createAdminCookie().split(";")[0]!;
  let privateReference = false;
  let published = false;
  const predicates: SQL[] = [];
  const select = mock.method(db, "select", () => ({
    from: () => ({
      where: (predicate: SQL) => ({
        limit: async () => {
          predicates.push(predicate);
          const result = calls++ % 2 === 0 ? privateReference : published;
          return result ? [{ id: 1 }] : [];
        },
      }),
    }),
  }) as any);
  let calls = 0;
  const oldPrivateDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const derivedRead = mock.fn(async () => [Buffer.from("durable-jpeg")]);
  const bucket = mock.method(objectStorageClient, "bucket", () => ({
    file: () => ({ download: derivedRead }),
  }) as any);
  const file = mock.method(ObjectStorageService.prototype, "getObjectEntityFile",
    async () => ({ getMetadata: async () => [{ generation: "1" }] }) as any);
  const download = mock.method(ObjectStorageService.prototype, "downloadObject",
    async () => new Response("video", { headers: { "Cache-Control": "public, max-age=3600", "Content-Type": "video/mp4" } }));
  const app = express();
  app.use("/api", storageRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/storage/objects/`;
  const request = (path: string, options: RequestInit = {}) => fetch(base + path, options);
  try {
    // Pending/revoked/unknown media is denied before any storage read.
    for (const path of ["uploads/original", "uploads/signature", "automation/voiceover"]) {
      calls = 0;
      const denied = await request(path);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("cache-control"), "private, no-store");
      calls = 0;
      const deniedPreview = await request(`${path}?preview=1`);
      assert.equal(deniedPreview.status, 401);
      assert.equal(deniedPreview.headers.get("cache-control"), "private, no-store");
    }
    calls = 0;
    const deniedHead = await request("uploads/original", { method: "HEAD", headers: { Range: "bytes=0-1" } });
    assert.equal(deniedHead.status, 401);
    assert.equal(deniedHead.headers.get("cache-control"), "private, no-store");
    calls = 0;
    assert.equal((await request("uploads/original", { headers: { cookie: "top_dog_admin=forged" } })).status, 401);
    assert.equal(file.mock.callCount(), 0);
    published = true;
    calls = 0;
    const publicVideo = await request("automation/processed");
    assert.equal(publicVideo.status, 200);
    assert.equal(publicVideo.headers.get("cache-control"), "private, no-store");
    assert.equal(await publicVideo.text(), "video");
    const dialect = new PgDialect();
    const [privateQuery, publishedQuery] = predicates.slice(-2).map((predicate) =>
      dialect.sqlToQuery(predicate));
    for (const column of ["video_object_path", "signature_object_path", "voiceover_object_path"]) {
      assert.match(privateQuery!.sql, new RegExp(column));
    }
    assert.match(privateQuery!.sql, /\bor\b/);
    assert.deepEqual(privateQuery!.params, ["/objects/automation/processed",
      "/objects/automation/processed", "/objects/automation/processed"]);
    for (const column of ["status", "processing_status", "processed_video_object_path"]) {
      assert.match(publishedQuery!.sql, new RegExp(column));
    }
    assert.equal((publishedQuery!.sql.match(/\band\b/g) ?? []).length, 2);
    assert.deepEqual(publishedQuery!.params, ["approved", "completed", "/objects/automation/processed"]);
    calls = 0;
    const preview = await request("automation/processed?preview=1");
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type")!, /image\/jpeg/);
    assert.equal(preview.headers.get("cache-control"), "private, no-store");
    assert.equal(await preview.text(), "durable-jpeg");
    assert.equal(derivedRead.mock.callCount(), 1);
    // Warm the real durable-thumbnail path again before revoking publication.
    // The stored JPEG remains available; authorization must precede even a hit.
    calls = 0;
    const cachedPreview = await request("automation/processed?preview=1");
    assert.equal(cachedPreview.status, 200);
    assert.equal(await cachedPreview.text(), "durable-jpeg");
    assert.equal(derivedRead.mock.callCount(), 2);
    const sourceReadsBeforeRevocation = file.mock.callCount();
    const videoReadsBeforeRevocation = download.mock.callCount();
    published = false;
    calls = 0;
    const revokedPreview = await request("automation/processed?preview=1");
    assert.equal(revokedPreview.status, 401);
    assert.equal(revokedPreview.headers.get("cache-control"), "private, no-store");
    assert.ok(!(await revokedPreview.text()).includes("durable-jpeg"));
    assert.equal(derivedRead.mock.callCount(), 2);
    assert.equal(file.mock.callCount(), sourceReadsBeforeRevocation);
    assert.equal(download.mock.callCount(), videoReadsBeforeRevocation);
    published = true;
    calls = 0;
    const alias = await request("objects/automation/processed", { method: "HEAD" });
    assert.equal(alias.status, 200);
    assert.equal(alias.headers.get("cache-control"), "private, no-store");
    privateReference = true;
    calls = 0;
    assert.equal((await request("automation/processed?preview=1")).status, 401);
    assert.equal(derivedRead.mock.callCount(), 2);
    calls = 0;
    assert.equal((await request("automation/processed")).status, 401);
    privateReference = false;
    published = false;
    calls = 0;
    assert.equal((await request("automation/processed", { headers: { Range: "bytes=0-1" } })).status, 401);
    calls = 0;
    assert.equal((await request("automation/processed?preview=1")).status, 401);
    assert.equal((await request("uploads/original", { headers: { cookie: admin } })).status, 200);
    assert.equal((await request("uploads/original", { method: "HEAD", headers: { cookie: admin, Range: "bytes=0-1" } })).headers.get("cache-control"), "private, no-store");
    assert.equal((await request("uploads/%2fprivate", { headers: { cookie: admin } })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    select.mock.restore();
    file.mock.restore();
    download.mock.restore();
    bucket.mock.restore();
    if (oldPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = oldPrivateDir;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = oldSecret;
  }
});