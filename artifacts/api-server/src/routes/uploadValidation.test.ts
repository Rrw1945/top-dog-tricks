import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { db } from '@workspace/db';
import { ObjectStorageService, objectStorageClient } from '../lib/objectStorage';
import { InvalidUploadError, SIGNATURE_MAX_BYTES, VIDEO_MAX_BYTES, validateMediaContent, validateUploadMetadata } from '../lib/uploadValidation';
import storageRouter from './storage';
import { createSubmissionHandler } from './submissions';

test('metadata rejects unsupported, mismatched, empty, fractional and oversized uploads', () => {
  for (const contentType of ['video/webm', 'text/html', 'image/jpeg', 'image/svg+xml', 'application/pdf']) {
    assert.throws(() => validateUploadMetadata({ name: 'file.mp4', size: 1, contentType }), InvalidUploadError);
  }
  for (const size of [0, -1, 1.2, NaN, Infinity, VIDEO_MAX_BYTES + 1]) {
    assert.throws(() => validateUploadMetadata({ name: 'file.mp4', size, contentType: 'video/mp4' }));
  }
  assert.throws(() => validateUploadMetadata({ name: 'file.png', size: SIGNATURE_MAX_BYTES + 1, contentType: 'image/png' }));
  assert.throws(() => validateUploadMetadata({ name: 'file.webm', size: 10, contentType: 'video/mp4' }));
  assert.equal(validateUploadMetadata({ name: 'file.MP4', size: VIDEO_MAX_BYTES, contentType: 'video/mp4' }), 'video');
  assert.equal(validateUploadMetadata({ name: 'file.mov', size: 1, contentType: 'video/quicktime' }), 'video');
  assert.equal(validateUploadMetadata({ name: 'file.png', size: SIGNATURE_MAX_BYTES, contentType: 'image/png' }), 'signature');
});

test('synthetic media: real MP4/MOV/PNG accepted; forged MIME, truncation and oversized streams rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-fixtures-'));
  try {
    for (const extension of ['mp4', 'mov', 'png']) {
      const path = join(dir, `sample.${extension}`);
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
        'color=c=black:s=32x32:r=1', '-frames:v', '1', '-threads', '1', path]);
      const bytes = await readFile(path);
      const kind = extension === 'png' ? 'signature' : 'video';
      const type = extension === 'png' ? 'image/png' : extension === 'mp4' ? 'video/mp4' : 'video/quicktime';
      await validateMediaContent(Readable.from([bytes]), bytes.length, kind, type);
      await assert.rejects(validateMediaContent(Readable.from([bytes]), bytes.length - 1, kind, type), InvalidUploadError);
      await assert.rejects(validateMediaContent(Readable.from([bytes]), bytes.length + 1, kind, type), InvalidUploadError);
      await assert.rejects(validateMediaContent(Readable.from([bytes.subarray(0, 32)]), 32, kind, type), InvalidUploadError);
      if (kind === 'video') {
        await assert.rejects(validateMediaContent(Readable.from([bytes]), bytes.length, 'signature', 'image/png'), InvalidUploadError);
      }
    }
    for (const bytes of [Buffer.from('<html>not a movie</html>'), Buffer.alloc(128)]) {
      await assert.rejects(validateMediaContent(Readable.from([bytes]), bytes.length, 'video', 'video/mp4'), InvalidUploadError);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('storage sessions constrain bytes/type and prohibit overwrites; verification pins generation', async t => {
  t.mock.method(db, 'insert', () => ({ values: async () => [] }) as any);
  const service = new ObjectStorageService();
  t.mock.method(service, 'getPrivateObjectDir', () => '/fixture/private');
  const uploads: any[] = [], reads: any[] = [], copies: any[] = [];
  const metadata = { size: '20', contentType: 'video/mp4', generation: '123' };
  const bucket: any = { file: (name: string, options: unknown) => {
    reads.push({ name, options });
    return { name, bucket, getMetadata: async () => [metadata], exists: async () => [true],
      createResumableUpload: async (opts: unknown) => { uploads.push(opts); return ['https://storage.example/session']; },
      createReadStream: () => Readable.from([Buffer.alloc(20)]),
      copy: async (target: any, opts: unknown) => { copies.push({ target: target.name, opts }); },
    };
  } };
  t.mock.method(objectStorageClient, 'bucket', () => bucket);
  const result = await service.createEntryUpload({ name: 'a.mp4', size: 20, contentType: 'video/mp4' }, 'https://preview.example.com');
  assert.equal(uploads[0].origin, 'https://preview.example.com');
  assert.match(result.objectPath, /^\/objects\/uploads\/[a-f0-9-]{36}$/);
  assert.equal(uploads[0].metadata.contentLength, 20);
  assert.equal(uploads[0].metadata.contentType, 'video/mp4');
  assert.deepEqual(uploads[0].preconditionOpts, { ifGenerationMatch: 0 });
  await assert.rejects(service.validateEntryUpload(result.objectPath, 'video', 'video/mp4'), InvalidUploadError);
  assert.ok(reads.some(r => r.options?.generation === '123'));
  metadata.size = String(VIDEO_MAX_BYTES + 1);
  await assert.rejects(service.validateEntryUpload(result.objectPath, 'video'), InvalidUploadError);
  metadata.size = '20';
  await assert.rejects(service.validateEntryUpload(result.objectPath, 'signature'), InvalidUploadError);
  await assert.rejects(service.validateEntryUpload(result.objectPath, 'video', 'video/quicktime'), InvalidUploadError);
  for (const path of ['/objects/accepted/123', '/objects/automation/123', '/objects/uploads/../secret', 'https://example.com/file.mp4']) {
    await assert.rejects(service.validateEntryUpload(path, 'video'), InvalidUploadError);
  }
  const preserved = await service.preserveEntryUpload(bucket.file('private/uploads/source', { generation: '123' }), '/objects/accepted/11111111-1111-4111-8111-111111111111');
  assert.match(preserved, /^\/objects\/accepted\//);
  assert.deepEqual(copies[0].opts, { preconditionOpts: { ifGenerationMatch: 0 } });
});

test('anonymous routes reject bad metadata and stored media before inserts or external sends; valid entry uses preserved paths', async t => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error() {} } as any; next(); });
  let sideEffects = 0, inserts = 0;
  app.use('/api', storageRouter);
  app.post('/api/submissions', createSubmissionHandler(() => { sideEffects++; },
    async (_paths, work) => work(db as any),
    async () => ['/objects/accepted/video', '/objects/accepted/signature']));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const post = (path: string, data: unknown) => fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  let failure: Error | null = new InvalidUploadError('Invalid stored media');
  const checks: string[] = [];
  t.mock.method(ObjectStorageService.prototype, 'validateEntryUpload', async (_path: string, kind: string) => {
    checks.push(kind);
    if (failure) throw failure;
    return { name: kind } as any;
  });
  t.mock.method(ObjectStorageService.prototype, 'preserveEntryUpload', async (file: { name: string }) => `/objects/accepted/${file.name}`);
  const signed = t.mock.method(ObjectStorageService.prototype, 'createEntryUpload', async (input: Parameters<typeof validateUploadMetadata>[0], _origin?: string) => {
    validateUploadMetadata(input);
    return { uploadURL: 'https://storage.example/session', objectPath: '/objects/uploads/test' };
  });
  t.mock.method(db, 'insert', () => ({
    values: (values: any) => {
      inserts++;
      assert.equal(values.videoObjectPath, '/objects/accepted/video');
      assert.equal(values.signatureObjectPath, '/objects/accepted/signature');
      const origin = JSON.parse(values.websiteOrigin);
      assert.equal(origin.version, 1);
      assert.match(origin.receiptId, /^[a-f0-9-]{36}$/);
      assert.notEqual(values.websiteOrigin, 'client-forged-origin');
      return { returning: async () => [{
        ...values, id: 1, status: 'pending', processingStatus: 'awaiting_review',
        aiAnalysisStatus: 'pending', submittedAt: new Date(), updatedAt: new Date(),
      }] };
    },
  }) as any);
  const entry = { ownerName: 'Fixture', email: 'fixture@example.com', dogName: 'Dog',
    websiteOrigin: 'client-forged-origin',
    trickDescription: 'Synthetic fixture', videoObjectPath: '/objects/uploads/video',
    signatureObjectPath: '/objects/uploads/signature', videoFileName: 'test.mp4', videoContentType: 'video/mp4' };
  try {
    for (const input of [
      { name: 'a.mp4', size: VIDEO_MAX_BYTES + 1, contentType: 'video/mp4' },
      { name: 'a.png', size: SIGNATURE_MAX_BYTES + 1, contentType: 'image/png' },
      { name: 'a.webm', size: 20, contentType: 'video/webm' },
      { name: 'a.mp4', size: 0, contentType: 'video/mp4' },
    ]) assert.equal((await post('/storage/uploads/request-url', input)).status, 400);
    assert.equal((await post('/storage/uploads/request-url', { name: 'a.mp4', size: 20, contentType: 'video/mp4' })).status, 200);
    assert.ok(signed.mock.callCount() >= 1);
    assert.equal(signed.mock.calls.at(-1)?.arguments[1], undefined);
    const browserUpload = await fetch(`${url}/storage/uploads/request-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://preview.example.com' },
      body: JSON.stringify({ name: 'a.mp4', size: 20, contentType: 'video/mp4' }),
    });
    assert.equal(browserUpload.status, 200);
    assert.equal(signed.mock.calls.at(-1)?.arguments[1], 'https://preview.example.com');
    assert.equal((await post('/submissions', entry)).status, 400);
    assert.equal(inserts, 0);
    assert.equal(sideEffects, 0);
    failure = new Error('Storage unavailable');
    assert.equal((await post('/submissions', entry)).status, 503);
    assert.equal(inserts, 0);
    failure = null;
    const response = await post('/submissions', entry);
    const body = await response.json() as { videoObjectPath: string };
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(inserts, 1);
    assert.equal(sideEffects, 1);
    assert.deepEqual(checks.slice(-2), ['video', 'signature']);
    assert.equal(body.videoObjectPath, '/objects/accepted/video');
    assert.ok(!Object.hasOwn(body, 'websiteOrigin'), 'internal receipt stays out of public response');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
