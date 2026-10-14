import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { runInNewContext } from "node:vm";
import type { videoThumbnail } from "./videoThumbnail";

// The outer test runner bundles tests. Load esbuild at runtime, and execute a
// fresh copy of the actual module per test so caches/queues cannot leak.
const require = createRequire(import.meta.url);
const { transformSync } = require("esbuild") as typeof import("esbuild");
const source = readFileSync(resolve("src/lib/videoThumbnail.ts"), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs" }).code;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, discardWrites = false) {
  const dirs: string[] = [];
  const removals: string[] = [];
  const executions: Array<{ command: string; args: string[]; timeout: number }> = [];
  const timers: Array<{ ms: number; controller: AbortController }> = [];
  let now = 1_000;
  let extract: () => Promise<void> = async () => {};
  const dependencies: Record<string, unknown> = {
    "node:fs/promises": {
      ...fs,
      mkdtemp: async (prefix: string) => {
        const dir = await fs.mkdtemp(prefix);
        dirs.push(dir);
        return dir;
      },
      rm: async (dir: string, options: Parameters<typeof fs.rm>[1]) => {
        assert.equal(options?.recursive, true);
        assert.equal(options?.force, true);
        removals.push(dir);
        return fs.rm(dir, options);
      },
    },
    "node:fs": {
      createWriteStream: discardWrites
        ? () => new Writable({ write(_chunk, _encoding, next) { next(); } })
        : createWriteStream,
    },
    "node:child_process": {
      execFile(command: string, args: string[], options: { timeout: number },
        callback: (error: Error | null, stdout?: string, stderr?: string) => void) {
        executions.push({ command, args, timeout: options.timeout });
        void (async () => {
          await extract();
          await fs.writeFile(args.at(-1)!, "synthetic-jpeg");
        })().then(() => callback(null, "", ""), (error: Error) => callback(error));
      },
    },
  };
  const module = { exports: {} as { videoThumbnail: typeof videoThumbnail } };
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer,
    require: (id: string) => dependencies[id] ?? require(id),
    Date: { now: () => now },
    AbortSignal: {
      timeout(ms: number) {
        const controller = new AbortController();
        timers.push({ ms, controller });
        return controller.signal;
      },
    },
  });
  t.after(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    render: module.exports.videoThumbnail, dirs, executions, timers,
    setTime: (value: number) => { now = value; },
    setExtract: (fn: () => Promise<void>) => { extract = fn; },
    async assertClean() {
      assert.deepEqual(removals, dirs);
      for (const dir of dirs) await assert.rejects(fs.access(dir), { code: "ENOENT" });
    },
  };
}

const movie = async () => new Response("synthetic-movie");

test("never-resolving headers time out, reject duplicate waiters and release queued previews", async (t) => {
  const f = fixture(t);
  const started = deferred<AbortSignal>();
  const failed = f.render("stalled-headers", (signal) => {
    started.resolve(signal!);
    return new Promise<Response>(() => {});
  });
  const duplicate = f.render("stalled-headers", movie);
  assert.equal(duplicate, failed);
  const rejected = assert.rejects(failed, { name: "TimeoutError" });
  const duplicateRejected = assert.rejects(duplicate, { name: "TimeoutError" });
  const queued = f.render("healthy", movie);
  const signal = await started.promise;
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0]!.ms, 60_000);
  assert.equal(signal, f.timers[0]!.controller.signal);
  f.timers[0]!.controller.abort(new DOMException("Download timed out", "TimeoutError"));
  await Promise.all([rejected, duplicateRejected]);
  assert.equal(signal.aborted, true);
  assert.equal((await queued).toString(), "synthetic-jpeg");
  assert.equal((await f.render("stalled-headers", movie)).toString(), "synthetic-jpeg");
  assert.equal(f.executions.length, 2);
  await f.assertClean();
});

test("a response arriving after timeout is cancelled without extraction", async (t) => {
  const f = fixture(t);
  const started = deferred<void>();
  const late = deferred<Response>();
  const result = f.render("late", () => { started.resolve(); return late.promise; });
  const rejected = assert.rejects(result, { name: "AbortError" });
  await started.promise;
  f.timers[0]!.controller.abort();
  await rejected;
  const cancelled = deferred<void>();
  late.resolve(new Response(new ReadableStream({
    cancel() { cancelled.resolve(); },
  })));
  await cancelled.promise;
  assert.equal(f.executions.length, 0);
  await f.assertClean();
});

test("same-source bursts share one download/extraction and return cached bytes", async (t) => {
  const f = fixture(t);
  const gate = deferred<Response>();
  let downloads = 0;
  const first = f.render("same", () => { downloads++; return gate.promise; });
  const requests = Array.from({ length: 40 }, () => f.render("same", movie));
  for (const request of requests) assert.equal(request, first);
  gate.resolve(await movie());
  const results = await Promise.all([first, ...requests]);
  assert.equal(downloads, 1);
  assert.equal(f.executions.length, 1);
  for (const bytes of results) assert.equal(bytes, results[0]);
  assert.equal(await f.render("same", async () => { throw new Error("cache miss"); }), results[0]);
  assert.equal(f.executions[0]!.command, "ffmpeg");
  await f.assertClean();
});

test("queue admits 16 distinct sources, deduplicates while full, and extracts serially", async (t) => {
  const f = fixture(t);
  const gate = deferred<void>();
  const started = deferred<void>();
  let active = 0;
  let maximum = 0;
  f.setExtract(async () => {
    maximum = Math.max(maximum, ++active);
    started.resolve();
    await gate.promise;
    active--;
  });
  const requests = Array.from({ length: 16 }, (_, i) => f.render(`key-${i}`, movie));
  const settled = Promise.all(requests);
  try {
    await started.promise;
    assert.equal(f.executions.length, 1);
    assert.equal(f.dirs.length, 1);
    assert.equal(f.render("key-15", movie), requests[15]);
    await assert.rejects(f.render("overflow", movie), /Thumbnail queue is full/);
  } finally {
    gate.resolve();
    await settled;
  }
  assert.equal(maximum, 1);
  assert.equal(f.executions.length, 16);
  await f.render("overflow", movie);
  assert.equal(f.executions.length, 17);
  await f.assertClean();
});

test("extractor timeout rejects all waiters, removes files, and allows queued work and retry", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.setExtract(async () => {
    if (++attempts === 1) throw Object.assign(new Error("ffmpeg timed out"), { killed: true });
  });
  const failed = f.render("failed", movie);
  const duplicate = f.render("failed", movie);
  const rejection = assert.rejects(failed, /ffmpeg timed out/);
  const duplicateRejection = assert.rejects(duplicate, /ffmpeg timed out/);
  const queued = f.render("healthy", movie);
  await Promise.all([rejection, duplicateRejection]);
  assert.equal((await queued).toString(), "synthetic-jpeg");
  assert.equal((await f.render("failed", movie)).toString(), "synthetic-jpeg");
  assert.equal(f.executions.length, 3);
  for (const execution of f.executions) assert.equal(execution.timeout, 30_000);
  await f.assertClean();
});

test("download timeout aborts the pipeline, cancels the source and cleans up", async (t) => {
  const f = fixture(t);
  const writing = deferred<void>();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() { writing.resolve(); },
    cancel() { cancelled = true; },
  });
  const result = f.render("stalled", async () => new Response(stream));
  const rejected = assert.rejects(result, { name: "AbortError" });
  await writing.promise;
  // Wait for pipeline installation rather than advancing a real 60-second timer.
  while (!f.timers.length) await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.timers[0]!.ms, 60_000);
  f.timers[0]!.controller.abort();
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(f.executions.length, 0);
  await f.render("stalled", movie);
  await f.assertClean();
});

test("failed downloads and oversized streams never reach extraction and release the queue", async (t) => {
  const f = fixture(t, true);
  await assert.rejects(f.render("http-error", async () => new Response("bad", { status: 503 })),
    /Video download failed/);
  await assert.rejects(f.render("empty", async () => new Response(null)), /Video download failed/);
  // Reuse one synthetic MiB; discard disk writes while exercising the actual
  // byte-counting Transform at its production 500 MiB limit.
  const chunk = new Uint8Array(1024 * 1024);
  let chunks = 0;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++chunks <= 501) controller.enqueue(chunk);
      else controller.close();
    },
  });
  await assert.rejects(f.render("large", async () => new Response(oversized)), /Video too large/);
  assert.equal(f.executions.length, 0);
  await f.render("large", movie);
  await f.assertClean();
});

test("cache expires at ten minutes and evicts the oldest entry after 64 sources", async (t) => {
  const f = fixture(t);
  const original = await f.render("expires", movie);
  f.setTime(600_999);
  assert.equal(await f.render("expires", movie), original);
  assert.equal(f.executions.length, 1);
  f.setTime(601_000);
  await f.render("expires", movie);
  assert.equal(f.executions.length, 2);
  for (let i = 0; i < 64; i++) await f.render(`cache-${i}`, movie);
  const count = f.executions.length;
  await f.render("cache-0", movie);
  await f.render("cache-63", movie);
  assert.equal(f.executions.length, count);
  await f.render("expires", movie);
  assert.equal(f.executions.length, count + 1);
  await f.render("cache-0", movie);
  assert.equal(f.executions.length, count + 2);
  await f.assertClean();
});
