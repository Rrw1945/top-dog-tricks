import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { assertHistoricalFrameWindow } from './refreshVideoTitles';
import { buildHookLine, buildVideoTitleFilter, wrapHookText } from '../lib/videoTitleStyle';

const exec = promisify(execFile);
const oldProbe = {
  durationSeconds: 10, videoDurationSeconds: 10, videoFrameCount: 300,
  width: 360, height: 640, frameRate: '30/1', hasAudio: true,
};
const audio = {
  packetCount: 470, startSeconds: -0.021333, endSeconds: 10,
  packetSha256: 'fixture',
};

describe('historical title refresh frame safety', () => {
  it('allows an exact frame reconstruction', () => {
    assertHistoricalFrameWindow(oldProbe, { ...oldProbe, hasAudio: false }, audio);
  });

  it('requires audio packet boundary evidence for a small encoder tail', () => {
    const normalized = { ...oldProbe, videoFrameCount: 308, videoDurationSeconds: 308 / 30 };
    assertHistoricalFrameWindow(oldProbe, normalized, audio);
    assert.throws(() => assertHistoricalFrameWindow(oldProbe, normalized, {
      ...audio, endSeconds: 10.5,
    }), /Historical tail cannot be verified/);
    assert.throws(() => assertHistoricalFrameWindow(oldProbe, normalized, {
      ...audio, endSeconds: 9,
    }), /Historical tail cannot be verified/);
  });

  it('blocks large mismatches, missing frames and inconsistent frame durations', () => {
    for (const normalized of [
      { ...oldProbe, videoFrameCount: 309, videoDurationSeconds: 309 / 30 },
      { ...oldProbe, videoFrameCount: 150, videoDurationSeconds: 5 },
      { ...oldProbe, videoFrameCount: 308, videoDurationSeconds: 11 },
      { ...oldProbe, width: 1080 },
    ]) {
      assert.throws(() => assertHistoricalFrameWindow(oldProbe, normalized, audio));
    }
  });
});

describe('real title refresh render fixture', () => {
  it('retains every historical video frame and mixed AAC packet without shortest or new speech', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'title-refresh-fixture-'));
    const source = join(dir, 'source.mp4');
    const old = join(dir, 'old.mp4');
    const refreshed = join(dir, 'refreshed.mp4');
    const title = join(dir, 'title.txt');
    const ffmpeg = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);
    const video = async (file: string) => {
      const { stdout } = await exec('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=nb_frames,duration,width,height,avg_frame_rate',
        '-of', 'json', file,
      ]);
      return JSON.parse(stdout).streams;
    };
    const packets = async (file: string) => {
      const { stdout } = await exec('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0', '-show_packets',
        '-show_data_hash', 'sha256',
        '-show_entries', 'packet=pts_time,dts_time,duration_time,size,data_hash',
        '-of', 'json', file,
      ]);
      return JSON.parse(stdout).packets;
    };
    try {
      await ffmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=2',
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', source,
      ]);
      await ffmpeg([
        '-i', source, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.8',
        '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', old,
      ]);
      await writeFile(title, wrapHookText(buildHookLine({
        dogName: 'Blue', punchline: 'A perfect pirouette on two paws.',
      }), 360));
      const filter = buildVideoTitleFilter({
        hookTextPath: title, targetWidth: 360, targetHeight: 640,
      });
      const frameCount = Number((await video(old))[0].nb_frames);
      await ffmpeg([
        '-i', source, '-i', old,
        '-vf', `${filter},trim=end_frame=${frameCount}`,
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-c:a', 'copy', refreshed,
      ]);
      assert.deepEqual(await video(refreshed), await video(old));
      assert.deepEqual(await packets(refreshed), await packets(old));
      await ffmpeg(['-i', old, '-map', '0:a', '-c:a', 'copy', '-f', 'adts', join(dir, 'old.aac')]);
      await ffmpeg(['-i', refreshed, '-map', '0:a', '-c:a', 'copy', '-f', 'adts', join(dir, 'new.aac')]);
      assert.deepEqual(await readFile(join(dir, 'new.aac')), await readFile(join(dir, 'old.aac')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});