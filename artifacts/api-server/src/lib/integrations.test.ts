import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { ReplitConnectors } from '@replit/connectors-sdk';
import type { Submission } from '@workspace/db';
import {
  sendSlackAnalyticsCoverageRegression,
  sendSlackPreview,
  syncSubmissionToExternalSystems,
  updateAirtableSubmission,
  updateAirtableProcessedMedia,
} from './integrations';
import { ObjectStorageService } from './objectStorage';
import { captureSubmissionOrigin, MAIN_PREVIEW_HOST } from './submissionOrigin';

const submission = {
  id: 42,
  dogName: 'Milo & Pals',
  trickName: 'High five',
  punchline: 'Paws up!',
  videoObjectPath: '/objects/original',
  processedVideoObjectPath: '/objects/processed',
} as Submission;
const videoBytes = Buffer.from([0, 1, 2, 3, 255]);
const uploadUrl = 'https://uploads.slack.test/video';

test('Airtable transfers raw media via a signed attachment but stores an authenticated stable review link', async () => {
  const signedUrl = 'https://storage.googleapis.com/signed-private-test';
  const getFile = mock.method(ObjectStorageService.prototype, 'getObjectEntityFile', async () => {
    throw new Error('No release fixture');
  });
  const grant = mock.method(ObjectStorageService.prototype, 'getObjectEntityReadURL', async (path: string) => {
    assert.ok(['/objects/original', '/objects/processed'].includes(path));
    return signedUrl;
  });
  const fields: Record<string, unknown>[] = [];
  const proxy = mock.method(ReplitConnectors.prototype, 'proxy', async (
    connector: string, _path: string, options?: { body?: unknown },
  ) => {
    assert.equal(connector, 'airtable');
    const payload = JSON.parse(String(options?.body));
    fields.push(payload.records[0].fields);
    return Response.json({ records: [{ id: `record-${fields.length}` }] });
  });
  try {
    const origin = captureSubmissionOrigin({ REPLIT_DEV_DOMAIN: MAIN_PREVIEW_HOST });
    const result = await syncSubmissionToExternalSystems({
      ...submission,
      videoFileName: 'original.mp4',
      websiteOrigin: origin,
    }, 'https://topdogtricks.example');
    assert.equal(result.airtableSubmissionId, 'record-2');
    assert.deepEqual(fields[1]?.['Raw Video File'], [{ url: signedUrl, filename: 'original.mp4' }]);
    assert.equal(fields[1]?.['Raw Video Drive'], 'https://topdogtricks.example/admin?submission=42');
    assert.ok(!JSON.stringify(fields[1]).includes('/api/storage/objects/'));
    assert.equal(grant.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(String(fields[1]?.['Website Origin'])), {
      ...JSON.parse(origin), websiteSubmissionId: 42,
    });
    assert.equal(fields[0]?.['Website Origin'], undefined);
    fields.length = 0;
    await syncSubmissionToExternalSystems({ ...submission, websiteOrigin: null }, 'https://topdogtricks.example');
    assert.ok(!Object.hasOwn(fields[1], 'Website Origin'), 'no inferred origin for old rows');
    fields.length = 0;
    const linked = { ...submission, airtableSubmissionId: 'record-2', websiteOrigin: origin };
    await updateAirtableSubmission(linked);
    await updateAirtableProcessedMedia(linked, 'https://topdogtricks.example');
    for (const patch of fields) {
      assert.ok(!Object.hasOwn(patch, 'Website Origin'), 'updates must preserve receipt');
      assert.ok(!Object.hasOwn(patch, 'Raw Video Drive'), 'updates must preserve reviewer URL');
    }
  } finally {
    proxy.mock.restore();
    grant.mock.restore();
    getFile.mock.restore();
  }
});

test('Slack preview requests a form-encoded upload URL and uploads the processed bytes', async () => {
  const paths: string[] = [];
  const storage = mock.method(ObjectStorageService.prototype, 'getObjectEntityFile', async (path: string) => {
    assert.equal(path, '/objects/processed');
    return { download: async () => [videoBytes] } as any;
  });
  const proxy = mock.method(
    ReplitConnectors.prototype,
    'proxy',
    async (connector: string, path: string, options?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      assert.equal(connector, 'slack');
      assert.equal(options?.method, 'POST');
      paths.push(path);
      if (path === '/files.getUploadURLExternal') {
        assert.equal(options?.headers?.['Content-Type'], 'application/x-www-form-urlencoded');
        assert.equal(typeof options?.body, 'string');
        const params = new URLSearchParams(options?.body as string);
        assert.deepEqual([...params.entries()], [
          ['filename', 'Milo & Pals-42-preview.mp4'],
          ['length', String(videoBytes.length)],
        ]);
        return Response.json({ ok: true, upload_url: uploadUrl, file_id: 'file-42' });
      }
      assert.equal(options?.headers?.['Content-Type'], 'application/json');
      const body = JSON.parse(options?.body as string);
      if (path === '/files.completeUploadExternal') {
        assert.deepEqual(body.files, [{ id: 'file-42', title: 'Milo & Pals-42-preview.mp4' }]);
        return Response.json({ ok: true });
      }
      assert.equal(path, '/chat.postMessage');
      assert.match(body.text, /Paws up!/);
      return Response.json({ ok: true });
    },
  );
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    assert.equal(url, uploadUrl);
    assert.equal(options?.method, 'POST');
    assert.equal((options?.headers as Record<string, string>)?.['Content-Type'], 'video/mp4');
    assert.deepEqual(options?.body, videoBytes);
    return new Response('', { status: 200 });
  });
  try {
    await sendSlackPreview(submission, 'https://topdogtricks.com');
    assert.deepEqual(paths, [
      '/files.getUploadURLExternal',
      '/files.completeUploadExternal',
      '/chat.postMessage',
    ]);
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    fetchMock.mock.restore();
    proxy.mock.restore();
    storage.mock.restore();
  }
});

test('Slack upload URL errors stop before any media upload or message', async () => {
  const storage = mock.method(ObjectStorageService.prototype, 'getObjectEntityFile', async () =>
    ({ download: async () => [videoBytes] }) as any);
  const proxy = mock.method(ReplitConnectors.prototype, 'proxy', async (
    connector: string,
    path: string,
  ) => {
    assert.equal(connector, 'slack');
    assert.equal(path, '/files.getUploadURLExternal');
    return Response.json({ ok: false, error: 'missing_scope' });
  });
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected external upload');
  });
  try {
    await assert.rejects(sendSlackPreview(submission, 'https://topdogtricks.com'), /Slack upload URL failed: missing_scope/);
    assert.equal(proxy.mock.callCount(), 1);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
    proxy.mock.restore();
    storage.mock.restore();
  }
});

test("Slack coverage alerts carry the shared idempotency identity and aggregate data", async () => {
  let body: Record<string, unknown> | undefined;
  const proxy = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async (connector: string, path: string, options?: { body?: unknown }) => {
      assert.equal(connector, "slack");
      assert.equal(path, "/chat.postMessage");
      body = JSON.parse(String(options?.body));
      return Response.json({ ok: true });
    },
  );
  try {
    await sendSlackAnalyticsCoverageRegression(
      {
        cohorts: [
          { cohort: "2026-08-03", requests: 0 },
          { cohort: "2026-08-10", requests: 12 },
        ],
      },
      "319d8876-f23a-5c0b-b327-774047cbb5c9",
    );
    assert.equal(body?.client_msg_id, "319d8876-f23a-5c0b-b327-774047cbb5c9");
    assert.match(String(body?.text), /2026-08-03: 0 native requests/);
    assert.match(String(body?.text), /2026-08-10: 12 native requests/);
  } finally {
    proxy.mock.restore();
  }
});