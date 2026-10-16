import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { File } from '@google-cloud/storage';
import { durableVideoThumbnail } from '../lib/durableVideoThumbnail';
import { parsePrewarmOptions, runThumbnailPrewarm, type PrewarmDependencies } from './thumbnailPrewarm';

const rows = [2, 4, 8, 10].map(id => ({
  id, processedVideoObjectPath: `/objects/private-${id}`,
}));
const select: PrewarmDependencies['select'] = async options =>
  rows.filter(row => row.id > options.afterId && row.id <= options.throughId)
    .slice(0, options.limit + 1);

test('CLI defaults are safe and rejects invalid, conflicting, or unbounded options', () => {
  assert.deepEqual(parsePrewarmOptions([]), {
    apply: false, afterId: 0, throughId: 2147483647, limit: 100,
  });
  for (const args of [
    ['--limit', '0'], ['--limit', '1001'], ['--limit', '1.2'],
    ['--after-id', '-1'], ['--through-id', '2147483648'],
    ['--after-id', '8', '--through-id', '2'], ['--limit'],
    ['--apply', '--dry-run'], ['--apply', '--apply'],
    ['--limit', '2', '--limit', '3'], ['https://private.invalid/secret'],
    ['--after-id', '1e3'],
  ]) {
    assert.throws(() => parsePrewarmOptions(args), error =>
      error instanceof Error && error.message.startsWith('Usage:') &&
      !error.message.includes('secret'));
  }
});

test('dry-run is bounded, paginates by ID, and never touches media', async () => {
  const events: unknown[] = [];
  const summary = await runThumbnailPrewarm(
    parsePrewarmOptions(['--dry-run', '--limit', '2']),
    { select, prepare: async () => assert.fail('dry-run storage access'), report: e => events.push(e) },
  );
  assert.equal(summary.attempted, 2);
  assert.equal(summary.ready, 0);
  assert.equal(summary.resumeAfterId, 4);
  assert.equal(summary.hasMore, true);
  assert.equal(JSON.stringify(events).includes('/objects/'), false);
  const next = await runThumbnailPrewarm(
    parsePrewarmOptions(['--after-id', '4', '--through-id', '8']),
    { select, prepare: async () => assert.fail(), report: () => {} },
  );
  assert.equal(next.attempted, 1);
  assert.equal(next.resumeAfterId, 8);
  assert.equal(next.hasMore, false);
});

test('failures are redacted, do not stop later items, and freeze the safe retry cursor', async () => {
  const events: unknown[] = [];
  const visited: string[] = [];
  const summary = await runThumbnailPrewarm(parsePrewarmOptions(['--apply']), {
    select,
    prepare: async path => {
      visited.push(path);
      if (path.endsWith('-4') || path.endsWith('-10')) {
        throw new Error(`PRIVATE ${path} https://signed.invalid/?token=secret`);
      }
    },
    report: event => events.push(event),
  });
  assert.equal(visited.length, 4);
  assert.deepEqual(summary.failedIds, [4, 10]);
  assert.equal(summary.ready, 2);
  assert.equal(summary.resumeAfterId, 2);
  assert.equal(summary.scannedThroughId, 10);
  assert.equal(summary.hasMore, false);
  assert.doesNotMatch(JSON.stringify({ events, summary }), /PRIVATE|objects|signed|secret/);
  const retried: string[] = [];
  const retry = await runThumbnailPrewarm(parsePrewarmOptions(['--apply', '--after-id', '2']), {
    select, prepare: async path => { retried.push(path); }, report: () => {},
  });
  assert.deepEqual(retried, rows.slice(1).map(row => row.processedVideoObjectPath));
  assert.equal(retry.resumeAfterId, 10);
});

test('interruption waits for the active item, then stops scheduling; empty batches are safe', async () => {
  let stopped = false;
  let active = 0;
  const summary = await runThumbnailPrewarm(parsePrewarmOptions(['--apply']), {
    select,
    prepare: async () => {
      assert.equal(++active, 1);
      await Promise.resolve();
      stopped = true;
      active--;
    },
    stopped: () => stopped,
    report: () => {},
  });
  assert.equal(summary.attempted, 1);
  assert.equal(summary.resumeAfterId, 2);
  assert.equal(summary.interrupted, true);
  assert.equal(summary.hasMore, true);
  const empty = await runThumbnailPrewarm(parsePrewarmOptions(['--after-id', '10']), {
    select, prepare: async () => assert.fail(), report: () => assert.fail(),
  });
  assert.equal(empty.attempted, 0);
  assert.equal(empty.resumeAfterId, 10);
  assert.equal(empty.hasMore, false);
});

test('repeated apply uses the real durable helper without rendering or overwriting existing thumbnails', async () => {
  const objects = new Map<string, Buffer>();
  let renders = 0;
  let saves = 0;
  const source = {
    name: 'private-processed',
    getMetadata: async () => [{ generation: '42' }],
    bucket: { file: () => source },
  } as unknown as File;
  const prepare = (path: string) => durableVideoThumbnail(path, source, undefined, {
    destination: identity => ({
      download: async () => {
        if (!objects.has(identity)) throw { code: 404 };
        return [objects.get(identity)];
      },
      save: async (bytes: Buffer, options: any) => {
        assert.equal(options.metadata.cacheControl, 'private, no-store');
        assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
        objects.set(identity, bytes);
        saves++;
      },
    }) as unknown as File,
    render: async () => { renders++; return Buffer.from('jpeg'); },
  });
  for (let run = 0; run < 2; run++) {
    const summary = await runThumbnailPrewarm(parsePrewarmOptions(['--apply']), {
      select, prepare, report: () => {},
    });
    assert.equal(summary.ready, 4);
    assert.deepEqual(summary.failedIds, []);
  }
  assert.equal(renders, 4);
  assert.equal(saves, 4);
});
