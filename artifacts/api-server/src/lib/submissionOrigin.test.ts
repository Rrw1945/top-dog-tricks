import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureSubmissionOrigin, MAIN_PREVIEW_HOST, websiteOriginField } from './submissionOrigin';

test('main, separate task previews and production remain distinct despite shared reviewer URL and project', () => {
  const common = {
    REPL_ID: '39e6427c-2934-4c24-aaf8-22edf2995a79',
    PUBLIC_APP_URL: 'https://topdogtricks.com',
    DATABASE_URL: 'postgres://private-user:private-password@private-host/private-db',
    SESSION_SECRET: 'secret-session-sentinel',
    ADMIN_PASSWORD: 'secret-admin-sentinel',
  };
  const contexts = [
    { ...common, REPLIT_DEV_DOMAIN: MAIN_PREVIEW_HOST },
    { ...common, REPLIT_DEV_DOMAIN: 'task-one.example.replit.dev' },
    { ...common, REPLIT_DEV_DOMAIN: 'task-two.example.replit.dev' },
    { ...common, REPLIT_DEV_DOMAIN: MAIN_PREVIEW_HOST, REPLIT_DEPLOYMENT: '1' },
  ];
  const receipts = contexts.map(context => JSON.parse(captureSubmissionOrigin(context)));
  assert.deepEqual(receipts.map(r => r.environment), [
    'main-preview', 'other-preview', 'other-preview', 'production',
  ]);
  assert.equal(new Set(receipts.map(r => r.sourceId)).size, 4);
  assert.equal(new Set(receipts.map(r => r.receiptId)).size, 4);
  for (const receipt of receipts) {
    const payload = websiteOriginField(JSON.stringify(receipt), 42)['Website Origin'];
    assert.equal(JSON.parse(payload).websiteSubmissionId, 42);
    for (const forbidden of Object.values(common)) assert.ok(!payload.includes(forbidden));
    assert.deepEqual(Object.keys(JSON.parse(payload)), [
      'version', 'environment', 'sourceId', 'receiptId', 'receivedAt', 'websiteSubmissionId',
    ]);
  }
  assert.equal(JSON.parse(captureSubmissionOrigin(contexts[1])).sourceId, receipts[1].sourceId);
});

test('unknown runtimes and malformed identifiers are explicit, never guessed from public URL or NODE_ENV', () => {
  for (const host of [undefined, '', 'https://user:password@example.replit.dev', 'example.com', 'host.replit.dev/path']) {
    const receipt = JSON.parse(captureSubmissionOrigin({
      REPLIT_DEV_DOMAIN: host, NODE_ENV: 'production', PUBLIC_APP_URL: 'https://topdogtricks.com',
    }));
    assert.equal(receipt.environment, 'unknown');
    assert.match(receipt.sourceId, /^process-/);
    assert.ok(!JSON.stringify(receipt).includes('password'));
  }
});

test('stored receipt is reused across runtime changes, historical records remain blank, and corrupt data fails safely', () => {
  const original = captureSubmissionOrigin({ REPLIT_DEV_DOMAIN: MAIN_PREVIEW_HOST });
  const before = websiteOriginField(original, 42);
  captureSubmissionOrigin({ REPLIT_DEPLOYMENT: '1' });
  assert.deepEqual(websiteOriginField(original, 42), before);
  assert.deepEqual(websiteOriginField(null, 42), {});
  assert.deepEqual(websiteOriginField(undefined, 42), {});
  for (const invalid of ['password', '{}', JSON.stringify({ ...JSON.parse(original), credential: 'secret' })]) {
    assert.throws(() => websiteOriginField(invalid, 42), { message: 'Invalid stored website origin' });
  }
});
