import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { loadMaintenanceHarness } from './refreshVideoTitles.test-harness';

describe('maintenance command scope guards', { concurrency: false }, () => {
  let dir: string;
  let manifestPath: string;
  let harness: Awaited<ReturnType<typeof loadMaintenanceHarness>>;
  const previousEnvironment = process.env.NODE_ENV;
  const confirmation = ['--confirm-apply', 'REFRESH_VIDEO_TITLES_DEV'];
  const row = (id: number) => ({
    id, status: 'approved', processingStatus: 'completed',
    videoObjectPath: `/objects/source-${id}`,
    processedVideoObjectPath: `/objects/old-${id}`,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    trimStartSeconds: 0, trimEndSeconds: null,
    dogName: 'Fixture', trickName: 'Spin',
  });
  const args = (mode: string, ids = '1', extra: string[] = []) => [
    mode, '--ids', ids, '--manifest', manifestPath,
    '--work-dir', join(dir, 'work'), ...extra,
  ];
  const writeManifest = (ids: number[]) => writeFile(manifestPath, JSON.stringify({
    schemaVersion: 3, mode: 'development-title-refresh',
    runId: 'scope-fixture', createdAt: '2026-01-01T00:00:00Z',
    // Applied entries need no media; removing an ID/confirmation guard would
    // otherwise let apply succeed, rather than fail on unrelated render data.
    entries: ids.map(id => ({ ...row(id), state: 'applied' })),
  }));
  const rejectsWithoutWrites = async (argv: string[], message: string) => {
    const rows = structuredClone(harness.state.rows);
    const objects = new Map([...harness.state.objects].map(([key, bytes]) => [
      key, Buffer.from(bytes),
    ]));
    const manifest = await readFile(manifestPath, 'utf8');
    await assert.rejects(harness.main(argv), { message });
    assert.deepEqual(harness.state.saves, [], 'no upload attempts');
    assert.deepEqual(harness.state.updates, [], 'no database update attempts');
    assert.deepEqual(harness.state.commits, [], 'no database commits');
    assert.deepEqual(harness.state.rows, rows, 'submission data is unchanged');
    assert.deepEqual(harness.state.objects, objects, 'stored objects are unchanged');
    assert.equal(await readFile(manifestPath, 'utf8'), manifest, 'manifest is unchanged');
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maintenance-command-'));
    manifestPath = join(dir, 'manifest.json');
    harness = await loadMaintenanceHarness(dir);
  });
  beforeEach(async () => {
    process.env.NODE_ENV = 'development';
    const { state } = harness;
    state.rows = [row(1), row(2)];
    state.objects.clear();
    state.objects.set('/objects/untouched', Buffer.from('existing object'));
    state.sources.clear();
    state.saves = []; state.updates = []; state.commits = []; state.downloads = [];
    state.crash = ''; state.race = false;
    await writeManifest([1]);
  });
  after(async () => {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const environment of [undefined, 'production', 'test', 'Development']) {
    for (const mode of ['inspect', 'prepare', 'apply']) {
      it(`rejects ${mode} with NODE_ENV=${environment ?? '(unset)'}`, async () => {
        if (environment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = environment;
        await rejectsWithoutWrites(args(mode, '1', mode === 'apply' ? confirmation : []),
          'This maintenance command only runs when NODE_ENV=development');
      });
    }
  }

  for (const [label, extra] of [
    ['missing flag', []],
    ['missing value', ['--confirm-apply']],
    ['wrong value', ['--confirm-apply', 'REFRESH_VIDEO_TITLES']],
    ['wrong case', ['--confirm-apply', 'refresh_video_titles_dev']],
  ] as const) {
    it(`rejects apply confirmation with ${label}`, async () => {
      await rejectsWithoutWrites(args('apply', '1', [...extra]),
        'apply requires --confirm-apply REFRESH_VIDEO_TITLES_DEV');
    });
  }

  for (const [label, requested, manifestIds] of [
    ['extra requested ID', '1,2', [1]],
    ['omitted manifest ID', '1', [1, 2]],
    ['different ID with the same count', '2', [1]],
  ] as const) {
    it(`rejects manifest scope mismatch: ${label}`, async () => {
      await writeManifest([...manifestIds]);
      await rejectsWithoutWrites(args('apply', requested, confirmation),
        'Explicit --ids must exactly match the manifest IDs');
    });
  }

  for (const mode of ['inspect', 'prepare']) {
    for (const [label, patch, message] of [
      ['unapproved', { status: 'pending' }, 'IDs are missing or are not approved/completed: 2'],
      ['unfinished', { processingStatus: 'processing' }, 'IDs are missing or are not approved/completed: 2'],
      ['no processed video', { processedVideoObjectPath: null }, 'Submission 2 has no processed video'],
    ] as const) {
      it(`rejects ${mode} of a mixed batch containing an ${label} submission`, async () => {
        Object.assign(harness.state.rows[1]!, patch);
        await rejectsWithoutWrites(args(mode, '1,2'), message);
      });
    }
    it(`rejects ${mode} when a requested submission does not exist`, async () => {
      await rejectsWithoutWrites(args(mode, '1,3'),
        'IDs are missing or are not approved/completed: 3');
    });
  }

  for (const [mode, ids] of [
    ['inspect', '1'], ['apply', '1'], ['prepare', '1,2'],
    ['inspect', '1,2'], ['apply', '1,2'],
  ]) {
    it(`rejects historical recovery in ${mode} for IDs ${ids}`, async () => {
      await rejectsWithoutWrites(args(mode!, ids, [
        '--recover-detected-trim', ...(mode === 'apply' ? confirmation : []),
      ]), '--recover-detected-trim is restricted to preparing one explicit ID');
    });
  }

  it('allows single-ID prepare recovery through the scope guard to eligibility validation', async () => {
    harness.state.rows = [];
    await rejectsWithoutWrites(args('prepare', '1', ['--recover-detected-trim']),
      'IDs are missing or are not approved/completed: 1');
  });

  it('accepts the exact confirmation and the same manifest IDs in a different order', async () => {
    await writeManifest([1, 2]);
    await harness.main(args('apply', '2,1', confirmation));
    assert.deepEqual(harness.state.saves, []);
    assert.deepEqual(harness.state.updates, []);
    assert.deepEqual(harness.state.commits, []);
  });
});
