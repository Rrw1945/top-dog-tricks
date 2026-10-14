import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import express from 'express';
import { db } from '@workspace/db';
import { ObjectStorageService } from '../lib/objectStorage';
import { validateMediaContent } from '../lib/uploadValidation';
import { createSubmissionHandler } from './submissions';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'controlled inspection did not reach its expected state');
    await delay(5);
  }
}

// Separate cases prove that each failure returns a slot, rather than relying on
// one eventual successful request after all concurrent work has disappeared.
for (const failure of ['stream', 'timeout', 'parser'] as const) {
  test(`upload burst: ${failure} failure releases capacity and removes temporary files`, { timeout: 20_000 }, async t => {
    const root = await mkdtemp(join(os.tmpdir(), 'upload-capacity-test-'));
    const inspections = join(root, 'inspections');
    await mkdir(inspections);
    const media = new Map<string, Buffer>();
    for (const extension of ['mp4', 'png']) {
      const path = join(root, `fixture.${extension}`);
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
        'color=c=black:s=32x32:r=1', '-frames:v', '1', '-threads', '1', path]);
      media.set(extension, await readFile(path));
    }
    // Isolate inspection directories from other tests and actual server work.
    const tmpMock = t.mock.method(os, 'tmpdir', () => inspections);
    syncBuiltinESMExports();
    const controllers: AbortController[] = [];
    const timeoutMock = t.mock.method(AbortSignal, 'timeout', (ms: number) => {
      assert.equal(ms, 120_000, 'retain the production download deadline');
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    const streams = new Map<string, Readable>();
    const first = new PassThrough();
    const neighbor = new PassThrough();
    streams.set('first', first);
    streams.set('neighbor', neighbor);
    const video = media.get('mp4')!;
    const signature = media.get('png')!;
    // Preserve the MP4 header but omit its movie metadata, forcing a real
    // ffprobe parser failure rather than the earlier content-type check.
    const brokenVideo = video.subarray(0, 32);
    const firstBytes = failure === 'parser' ? brokenVideo : video;
    first.write(firstBytes);
    neighbor.write(video);
    let inserts = 0, sends = 0, copies = 0;
    t.mock.method(ObjectStorageService.prototype, 'validateEntryUpload', async (path: string, kind: 'video' | 'signature') => {
      const id = path.split('/').at(-1)!;
      const bytes = kind === 'signature' ? signature : id === 'first' ? firstBytes : video;
      const stream = streams.get(id) ?? Readable.from([bytes]);
      streams.set(id, stream);
      // Only the storage transport is substituted: capacity, disk writes,
      // pipeline cancellation and media parsing use the production validator.
      await validateMediaContent(stream, bytes.length, kind, kind === 'video' ? 'video/mp4' : 'image/png');
      return { name: kind } as any;
    });
    t.mock.method(ObjectStorageService.prototype, 'preserveEntryUpload', async (file: { name: string }) => {
      copies++;
      return `/objects/accepted/${file.name}`;
    });
    t.mock.method(db, 'insert', () => ({
      values: (values: any) => {
        inserts++;
        return { returning: async () => [{
          ...values, id: 1, status: 'pending', processingStatus: 'awaiting_review',
          aiAnalysisStatus: 'pending', submittedAt: new Date(), updatedAt: new Date(),
        }] };
      },
    }) as any);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.log = { error() {} } as any; next(); });
    app.post('/api/submissions', createSubmissionHandler(() => { sends++; },
      async (_paths, work) => work(db as any),
      async () => ['/objects/accepted/video', '/objects/accepted/signature']));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    type Result = { status: number; body: { error?: string; videoObjectPath?: string } };
    const pending: Promise<Result>[] = [];
    const post = (id: string) => {
      const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/submissions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerName: 'Fixture', email: 'fixture@example.com', dogName: 'Dog',
          trickDescription: 'Synthetic fixture', videoObjectPath: `/objects/uploads/${id}`,
          signatureObjectPath: `/objects/uploads/${id}-signature`,
          videoFileName: 'fixture.mp4', videoContentType: 'video/mp4',
        }),
      }).then(async response => ({
        status: response.status,
        body: await response.json() as Result['body'],
      }));
      pending.push(request);
      return request;
    };
    const noWrites = () => assert.deepEqual({ inserts, sends, copies }, { inserts: 0, sends: 0, copies: 0 });
    try {
      const firstRequest = post('first');
      await until(() => first.listenerCount('error') > 0);
      const neighborRequest = post('neighbor');
      await until(() => neighbor.listenerCount('error') > 0);
      assert.equal((await readdir(inspections)).length, 2);
      assert.equal(controllers.length, 2);

      const burst = await Promise.all(['extra-a', 'extra-b', 'extra-c'].map(post));
      assert.deepEqual(burst.map(result => result.status), [503, 503, 503]);
      for (const id of ['extra-a', 'extra-b', 'extra-c']) {
        assert.equal(streams.get(id)?.destroyed, true, 'rejected stream must be destroyed');
        assert.equal(streams.has(`${id}-signature`), false);
      }
      assert.equal(controllers.length, 2, 'rejected requests must not start download pipelines');
      assert.equal((await readdir(inspections)).length, 2, 'rejections must not leave extra directories');
      noWrites();

      if (failure === 'stream') first.destroy(new Error('Synthetic storage read failure'));
      else if (failure === 'timeout') controllers[0].abort(new DOMException('Synthetic deadline', 'TimeoutError'));
      else first.end();
      const failed = await firstRequest;
      assert.equal(failed.status, failure === 'parser' ? 400 : 503);
      if (failure === 'parser') assert.equal(failed.body.error, 'The uploaded media is damaged or unsupported.');
      assert.equal(first.destroyed, true);
      assert.equal(neighbor.destroyed, false, 'unrelated inspection must remain active');
      assert.equal((await readdir(inspections)).length, 1, 'failed inspection must remove its directory and media file');
      noWrites();

      const valid = await post('later');
      assert.equal(valid.status, 201, JSON.stringify(valid.body));
      assert.equal(valid.body.videoObjectPath, '/objects/accepted/video');
      assert.deepEqual({ inserts, sends, copies }, { inserts: 1, sends: 1, copies: 2 });
      assert.equal(streams.get('later')?.destroyed, true);
      assert.equal(streams.get('later-signature')?.destroyed, true);
      assert.equal((await readdir(inspections)).length, 1, 'successful inspections must remove their files too');

      neighbor.destroy(new Error('Synthetic neighbor cleanup'));
      assert.equal((await neighborRequest).status, 503);
      assert.equal(neighbor.destroyed, true);
      assert.deepEqual(await readdir(inspections), []);
      assert.deepEqual({ inserts, sends, copies }, { inserts: 1, sends: 1, copies: 2 });
    } finally {
      for (const stream of streams.values()) stream.destroy();
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled(pending);
      timeoutMock.mock.restore();
      tmpMock.mock.restore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}
