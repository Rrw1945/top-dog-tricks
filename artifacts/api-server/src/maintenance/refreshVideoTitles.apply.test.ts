import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { loadMaintenanceHarness } from './refreshVideoTitles.test-harness';

const exec = promisify(execFile);
const ffmpeg = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Manifest = {
  entries: Array<{
    id: number; state: string; renderedFile: string; renderedSha256: string;
    newObjectPath: string; oldAudioSha256: string;
    oldAudioPackets: { packetSha256: string };
    oldProbe: { durationSeconds: number; videoDurationSeconds: number; videoFrameCount: number };
    normalizedProbe: { videoFrameCount: number };
    footageSsim: number;
  }>;
};

describe('maintenance apply safeguards with local FFmpeg media', { concurrency: false }, () => {
  let dir: string;
  let harness: Awaited<ReturnType<typeof loadMaintenanceHarness>>;
  let prepared: Manifest;
  let original: string;
  let old: string;
  let manifestPath: string;
  const previousEnvironment = process.env.NODE_ENV;
  const row = (id: number) => ({
    id, videoObjectPath: `/objects/source-${id}`, processedVideoObjectPath: `/objects/old-${id}`,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'approved', processingStatus: 'completed',
    trimStartSeconds: 0, trimEndSeconds: null, dogName: 'Fixture', trickName: 'Spin',
  });
  const args = (mode: string, ids = '1') => [
    mode, '--ids', ids, '--manifest', manifestPath, '--work-dir', join(dir, 'work'),
    ...(mode === 'apply' ? ['--confirm-apply', 'REFRESH_VIDEO_TITLES_DEV'] : []),
  ];
  const readManifest = async () => JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  const reset = async (mutate?: (manifest: Manifest) => void) => {
    const { state } = harness;
    state.rows = [row(1), row(2)];
    state.objects.clear();
    state.updates = []; state.commits = []; state.saves = []; state.downloads = [];
    state.crash = ''; state.race = false;
    state.manifestFailure = null; state.manifestFaults = []; state.thumbnails = [];
    const manifest = structuredClone(prepared);
    mutate?.(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
    return manifest.entries[0]!;
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maintenance-safety-'));
    process.env.NODE_ENV = 'development';
    harness = await loadMaintenanceHarness(dir);
    original = join(dir, 'source.mp4');
    old = join(dir, 'old.mp4');
    manifestPath = join(dir, 'manifest.json');
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=160x240:rate=30:duration=1',
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', original,
    ]);
    // AAC priming creates an edit list; audio ends slightly before video.
    // This is deliberately not an equal-duration silent fixture.
    await ffmpeg([
      '-i', original, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.98',
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', old,
    ]);
    harness.state.rows = [row(1), row(2)];
    for (const id of [1, 2]) {
      harness.state.sources.set(`/objects/source-${id}`, original);
      harness.state.sources.set(`/objects/old-${id}`, old);
    }
    await harness.main(args('prepare'));
    prepared = await readManifest();
    assert.equal(harness.state.updates.length, 0);
    assert.equal(harness.state.saves.length, 0);
  });
  after(async () => {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('runs the real renderer while retaining unequal stream durations and edit-list packet timing', async () => {
    const entry = await reset();
    const streams = async (file: string) => JSON.parse((await exec('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,duration,nb_frames', '-of', 'json', file,
    ])).stdout).streams;
    const packets = async (file: string) => JSON.parse((await exec('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256',
      '-show_entries', 'packet=pts_time,dts_time,duration_time,size,data_hash', '-of', 'json', file,
    ])).stdout).packets;
    const oldStreams = await streams(old);
    assert.notEqual(oldStreams[0].duration, oldStreams[1].duration);
    assert.ok((await readFile(old)).includes(Buffer.from('elst')), 'fixture contains an MP4 edit list');
    assert.ok(Number((await packets(old))[0].pts_time) < 0, 'AAC priming must be represented');
    assert.deepEqual(await streams(entry.renderedFile), oldStreams);
    assert.deepEqual(await packets(entry.renderedFile), await packets(old));
    await harness.main(args('apply'));
    assert.deepEqual(harness.state.commits, [1]);
    assert.equal(harness.state.rows[0]!.processedVideoObjectPath, entry.newObjectPath);
    assert.deepEqual(harness.state.rows[0]!.updatedAt, row(1).updatedAt);
  });

  for (const [name, mutate, error] of [
    ['duration', (m: Manifest) => { m.entries[0]!.oldProbe.durationSeconds += 0.1; }, /Rendered media mismatch/],
    ['frame count', (m: Manifest) => { m.entries[0]!.oldProbe.videoFrameCount += 1; }, /Rendered media mismatch/],
    ['historical frame window', (m: Manifest) => { m.entries[0]!.normalizedProbe.videoFrameCount -= 1; }, /historical video frame window/],
    ['audio payload hash', (m: Manifest) => { m.entries[0]!.oldAudioSha256 = 'wrong'; }, /prepared audio no longer matches/],
    ['audio packet timing', (m: Manifest) => { m.entries[0]!.oldAudioPackets.packetSha256 = 'wrong'; }, /packet evidence changed/],
    ['footage', (m: Manifest) => { m.entries[0]!.footageSsim = 0.94; }, /no validated footage match/],
    ['missing footage evidence', (m: Manifest) => { m.entries[0]!.footageSsim = Number.NaN; }, /no validated footage match/],
    ['file hash', (m: Manifest) => { m.entries[0]!.renderedSha256 = 'wrong'; }, /file hash does not match/],
  ] as const) {
    it(`does not upload or touch the database after failed ${name} validation`, async () => {
      await reset(mutate);
      await assert.rejects(harness.main(args('apply')), error);
      assert.deepEqual(harness.state.updates, []);
      assert.deepEqual(harness.state.saves, []);
      assert.equal((await readManifest()).entries[0]!.state, 'prepared');
    });
  }

  for (const field of ['updatedAt', 'processedVideoObjectPath', 'videoObjectPath']) {
    it(`cannot overwrite a conflicting ${field}`, async () => {
      await reset();
      harness.state.rows[0]![field] = field === 'updatedAt'
        ? new Date('2026-02-01T00:00:00Z') : '/objects/reviewer-change';
      const before = structuredClone(harness.state.rows);
      await assert.rejects(harness.main(args('apply')), /optimistic update failed/);
      assert.deepEqual(harness.state.rows, before);
      assert.deepEqual(harness.state.commits, []);
      assert.equal((await readManifest()).entries[0]!.state, 'uploaded');
    });
  }

  it('refuses an occupied destination without changing its bytes', async () => {
    const entry = await reset();
    harness.state.objects.set(entry.newObjectPath, Buffer.from('existing bytes'));
    await assert.rejects(harness.main(args('apply')), /destination object exists with other bytes/);
    assert.equal(harness.state.objects.get(entry.newObjectPath)!.toString(), 'existing bytes');
    assert.deepEqual(harness.state.saves, []);
    assert.deepEqual(harness.state.updates, []);
  });

  it('uses an atomic create-only upload even when another writer wins after exists()', async () => {
    const entry = await reset();
    harness.state.race = true;
    await assert.rejects(harness.main(args('apply')), /412 generation precondition/);
    assert.equal(harness.state.saves[0]!.options.preconditionOpts.ifGenerationMatch, 0);
    assert.equal(harness.state.objects.get(entry.newObjectPath)!.toString(), 'racing writer');
    assert.deepEqual(harness.state.updates, []);
  });

  for (const crash of ['after-save', 'before-update', 'after-update']) {
    it(`resumes safely after interruption ${crash}`, async () => {
      const entry = await reset();
      harness.state.crash = crash;
      await assert.rejects(harness.main(args('apply')), /interrupted/);
      assert.equal((await readManifest()).entries[0]!.state, crash === 'after-save' ? 'prepared' : 'uploaded');
      const uploaded = Buffer.from(harness.state.objects.get(entry.newObjectPath)!);
      await harness.main(args('apply'));
      assert.deepEqual(harness.state.commits, [1], 'commit occurs exactly once');
      assert.equal(harness.state.saves.length, 1, 'resume verifies, never rewrites uploaded bytes');
      assert.deepEqual(harness.state.objects.get(entry.newObjectPath), uploaded);
      assert.equal((await readManifest()).entries[0]!.state, 'applied');
      const attempts = harness.state.updates.length;
      await harness.main(args('apply'));
      assert.equal(harness.state.updates.length, attempts, 'completed entries are skipped');
    });
  }

  for (const checkpoint of ['uploaded', 'applied'] as const) {
    for (const boundary of ['write', 'sync', 'rename', 'directory-sync'] as const) {
      it(`recovers ${checkpoint} progress after manifest ${boundary} fails`, async () => {
        const entry = await reset();
        const initialManifest = await readFile(manifestPath, 'utf8');
        const { state } = harness;
        state.manifestFailure = { boundary, checkpoint };
        await assert.rejects(harness.main(args('apply')), {
          message: `injected manifest ${boundary} failure at ${checkpoint}`,
        });
        assert.equal(state.manifestFailure, null, 'the intended fault was consumed');
        assert.equal(state.manifestFaults.length, 1);
        const fault = state.manifestFaults[0]!;
        assert.equal(fault.boundary, boundary);
        assert.equal(fault.checkpoint, checkpoint);
        const persisted = await readFile(manifestPath, 'utf8');
        assert.equal(persisted, fault.previous, 'failure leaves the target bytes intact');
        // Before rename the old snapshot survives; after rename the new snapshot
        // is readable, though directory durability across power loss is not promised.
        const expectedState = boundary === 'directory-sync'
          ? checkpoint : checkpoint === 'uploaded' ? 'prepared' : 'uploaded';
        assert.equal((await readManifest()).entries[0]!.state, expectedState);
        const expectedManifest = JSON.parse(initialManifest) as Manifest;
        expectedManifest.entries[0]!.state = expectedState;
        assert.deepEqual(await readManifest(), expectedManifest,
          'all manifest evidence survives the persistence failure');
        if (expectedState === 'prepared') assert.equal(persisted, initialManifest);
        if (boundary === 'write') {
          const partial = await readFile(`${manifestPath}.${process.pid}.tmp`, 'utf8');
          assert.throws(() => JSON.parse(partial), SyntaxError);
        }
        assert.deepEqual(state.commits, checkpoint === 'applied' ? [1] : []);
        assert.equal(state.updates.length, checkpoint === 'applied' ? 1 : 0);
        assert.equal(state.rows[0]!.processedVideoObjectPath,
          checkpoint === 'applied' ? entry.newObjectPath : row(1).processedVideoObjectPath);
        const uploaded = Buffer.from(state.objects.get(entry.newObjectPath)!);
        assert.equal(digest(uploaded), entry.renderedSha256);
        const downloads = state.downloads.length;

        await harness.main(args('apply'));
        assert.deepEqual(state.commits, [1], 'successful row commit is never repeated');
        assert.equal(state.saves.length, 1, 'retry does not rewrite uploaded bytes');
        assert.deepEqual(state.objects.get(entry.newObjectPath), uploaded);
        assert.equal(state.rows[0]!.processedVideoObjectPath, entry.newObjectPath);
        assert.deepEqual(state.rows[0]!.updatedAt, row(1).updatedAt);
        assert.equal((await readManifest()).entries[0]!.state, 'applied');
        if (expectedState !== 'applied') {
          assert.ok(state.downloads.length > downloads, 'retry verifies the existing upload');
        }
        const attempts = state.updates.length;
        const completed = await readFile(manifestPath, 'utf8');
        await harness.main(args('apply'));
        assert.equal(state.updates.length, attempts, 'completed entry makes no update attempt');
        assert.deepEqual(state.commits, [1]);
        assert.equal(state.saves.length, 1);
        assert.equal(await readFile(manifestPath, 'utf8'), completed);
      });
    }
  }

  it('resumes the next entry without repeating an already-applied entry', async () => {
    await reset(m => {
      const second = { ...structuredClone(m.entries[0]!), ...row(2),
        updatedAt: row(2).updatedAt.toISOString(), newObjectPath: '/objects/automation/second.mp4' };
      m.entries.push(second);
    });
    harness.state.objects.set('/objects/automation/second.mp4', Buffer.from('collision'));
    await assert.rejects(harness.main(args('apply', '1,2')), /destination object exists/);
    assert.deepEqual((await readManifest()).entries.map(e => e.state), ['applied', 'prepared']);
    harness.state.objects.delete('/objects/automation/second.mp4');
    await harness.main(args('apply', '1,2'));
    assert.deepEqual(harness.state.commits, [1, 2]);
    assert.deepEqual((await readManifest()).entries.map(e => e.state), ['applied', 'applied']);
  });

  it('rejects genuinely different footage during preparation before any write', async () => {
    await reset();
    const different = join(dir, 'different.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=160x240:rate=30:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', different]);
    harness.state.sources.set('/objects/source-1', different);
    try {
      await assert.rejects(harness.main(args('prepare')), /footage SSIM .* below/);
      assert.deepEqual(harness.state.updates, []);
      assert.deepEqual(harness.state.saves, []);
    } finally {
      harness.state.sources.set('/objects/source-1', original);
    }
  });

  it('blocks an altered local render even if the manifest file hash is refreshed', async () => {
    const altered = join(dir, 'altered-audio.mp4');
    const entry = await reset();
    await ffmpeg(['-i', entry.renderedFile, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.98',
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', altered]);
    const alteredHash = digest(await readFile(altered));
    await reset(m => {
      m.entries[0]!.renderedFile = altered;
      m.entries[0]!.renderedSha256 = alteredHash;
    });
    await assert.rejects(harness.main(args('apply')), /packet evidence changed/);
    assert.deepEqual(harness.state.updates, []);
    assert.deepEqual(harness.state.saves, []);
  });
});
