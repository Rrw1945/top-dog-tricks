import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBackgroundMusic, replacementAudioFilter } from './backgroundMusic';

test('replacement soundtrack renders to the full video length with and without music', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soundtrack-test-'));
  try {
    const music = join(dir, 'music.wav');
    const wav = createBackgroundMusic();
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.length, 44 + 24000 * 16 * 2);
    await writeFile(music, wav);
    for (const withMusic of [true, false]) {
      const out = join(dir, `${withMusic}.mp4`);
      const graph = replacementAudioFilter(2, withMusic);
      assert.ok(!graph.includes('[0:a]'));
      execFileSync('ffmpeg', [
        '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=64x64:r=30:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
        ...(withMusic ? ['-stream_loop', '-1', '-i', music] : []),
        '-filter_complex', graph, '-map', '0:v', '-map', '[aout]',
        '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', out,
      ], { timeout: 20000 });
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out], { encoding: 'utf8' }));
      const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      const audio = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
      assert.equal(Number(video.nb_frames), 60);
      assert.ok(Math.abs(Number(audio.duration) - 2) < 0.1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
