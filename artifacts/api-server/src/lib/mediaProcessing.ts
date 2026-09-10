import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Submission } from '@workspace/db';
import { textToSpeech } from '@workspace/integrations-openai-ai-server/audio';
import { ObjectStorageService } from './objectStorage';
import {
  handleTemporaryDirectoryCleanupFailure,
  type ErrorWithCleanupFailure,
} from './temporaryDirectoryCleanup';

const objectStorage = new ObjectStorageService();
const VOICEOVER_WORD_LIMIT = 24;
const HOOK_CHARACTER_LIMIT = 96;

type MediaProcessingDependencies = {
  getSourceBytes: (objectPath: string) => Promise<Buffer>;
  makeTempDir: () => Promise<string>;
  removeTempDir: (path: string) => Promise<void>;
  readFile: (path: string) => Promise<Buffer>;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  run: typeof run;
  textToSpeech: typeof textToSpeech;
  saveObject: (
    data: Buffer,
    contentType: string,
    extension: string,
  ) => Promise<string>;
};

export type MediaProcessingError = ErrorWithCleanupFailure;

function buildVoiceoverScript(submission: Submission): string {
  const dogName = submission.dogName.trim().replace(/[.!?]+$/, '');
  const trickName = submission.trickName.trim().replace(/[.!?]+$/, '');
  const whatHappens = submission.trickDescription.trim();
  const words = `This is ${dogName}, showing off ${trickName}. ${whatHappens}`.split(/\s+/);

  if (words.length <= VOICEOVER_WORD_LIMIT) {
    return words.join(' ');
  }

  return `${words.slice(0, VOICEOVER_WORD_LIMIT).join(' ').replace(/[,:;.!?]+$/, '')}…`;
}

function buildHookLine(submission: Submission): string {
  const headline = `${submission.dogName.trim()} • ${submission.trickName.trim()}`;
  const description = submission.trickDescription.trim();
  const fullHook = `${headline}\n${description}`;
  if (fullHook.length <= HOOK_CHARACTER_LIMIT) return fullHook;
  return `${fullHook.slice(0, HOOK_CHARACTER_LIMIT - 1).trimEnd()}…`;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function durationFromProbe(stderr: string): number {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function findTrimWindow(
  input: string,
  runCommand: typeof run = run,
): Promise<{ start: number; end?: number }> {
  const { stderr } = await runCommand('ffmpeg', [
    '-hide_banner',
    '-i',
    input,
    '-af',
    'silencedetect=noise=-42dB:d=0.4',
    '-f',
    'null',
    '-',
  ]);
  const duration = durationFromProbe(stderr);
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const start = starts[0] !== undefined && starts[0] < 0.75 && ends[0] !== undefined ? ends[0] : 0;
  const lastStart = starts.at(-1);
  const end = duration > 0 && lastStart !== undefined && ends.at(-1) !== undefined && ends.at(-1)! > duration - 0.75 ? lastStart : undefined;
  return { start, end: end && end - start > 1 ? end : undefined };
}

async function hasAudioStream(
  input: string,
  runCommand: typeof run = run,
): Promise<boolean> {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=index',
    '-of',
    'csv=p=0',
    input,
  ]);
  return stdout.trim().length > 0;
}

export async function processSubmissionMedia(
  submission: Submission,
  dependencyOverrides?: Partial<MediaProcessingDependencies>,
): Promise<{
  processedVideoObjectPath: string;
  voiceoverObjectPath: string;
}> {
  const dependencies: MediaProcessingDependencies = {
    getSourceBytes: async (objectPath) => {
      const source = await objectStorage.getObjectEntityFile(objectPath);
      const [bytes] = await source.download();
      return bytes;
    },
    makeTempDir: () => mkdtemp(join(tmpdir(), 'top-dog-')),
    removeTempDir: (path) => rm(path, { recursive: true, force: true }),
    readFile,
    writeFile,
    run,
    textToSpeech,
    saveObject: (data, contentType, extension) =>
      objectStorage.saveObjectEntity(data, contentType, extension),
    ...dependencyOverrides,
  };
  const workingDir = await dependencies.makeTempDir();
  const input = join(workingDir, 'input');
  const normalized = join(workingDir, 'normalized.mp4');
  const processed = join(workingDir, 'finished.mp4');
  const voiceMp3 = join(workingDir, 'voice.mp3');
  const hookText = join(workingDir, 'hook.txt');
  let processingError: unknown;

  try {
    const videoBytes = await dependencies.getSourceBytes(submission.videoObjectPath);
    await dependencies.writeFile(input, videoBytes);

    const detectedTrim = await findTrimWindow(input, dependencies.run);
    const trimStart = submission.trimStartSeconds ?? detectedTrim.start;
    const trimEnd =
      submission.trimEndSeconds !== null &&
      submission.trimEndSeconds !== undefined &&
      submission.trimEndSeconds > trimStart
        ? submission.trimEndSeconds
        : detectedTrim.end;
    const sourceHasAudio = await hasAudioStream(input, dependencies.run);
    const targetWidth = process.env.VIDEO_TARGET_WIDTH ?? '1080';
    const targetHeight = process.env.VIDEO_TARGET_HEIGHT ?? '1920';
    const videoCrf = process.env.VIDEO_CRF ?? '20';
    const videoPreset = process.env.VIDEO_PRESET ?? 'medium';
    const args = ['-y', '-hide_banner'];
    if (trimStart > 0) args.push('-ss', trimStart.toFixed(2));
    args.push('-i', input);
    if (trimEnd !== undefined) {
      args.push('-t', (trimEnd - trimStart).toFixed(2));
    }
    args.push(
      '-vf',
      `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`,
      '-map',
      '0:v:0',
      '-c:v',
      'libx264',
      '-preset',
      videoPreset,
      '-crf',
      videoCrf,
      '-r',
      '30',
      '-pix_fmt',
      'yuv420p',
    );
    if (sourceHasAudio) {
      args.push(
        '-map',
        '0:a:0',
        '-af',
        'highpass=f=80,lowpass=f=12000,afftdn=nf=-25',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
      );
    } else {
      args.push('-an');
    }
    args.push(
      '-movflags',
      '+faststart',
      normalized,
    );
    await dependencies.run('ffmpeg', args);

    const script = buildVoiceoverScript(submission);
    const voiceoverBytes = await dependencies.textToSpeech(
      script,
      'onyx',
      'mp3',
      'Use an original warm adult male voice with a folksy, dry, welcoming quality. Speak at an unhurried pace with natural pauses, understated humor, and a slight knowing smile, like a calm late-night radio host casually telling a neighbor about a delightful dog. Keep it intimate, plainspoken, and quietly amused—not polished, promotional, theatrical, salesy, or announcer-like. Do not imitate or impersonate any real person.',
    );
    if (voiceoverBytes.length === 0) {
      throw new Error('Professional voiceover service returned empty audio');
    }
    await Promise.all([
      dependencies.writeFile(voiceMp3, voiceoverBytes),
      dependencies.writeFile(hookText, buildHookLine(submission)),
    ]);

    const hookHeight = Math.round(Number(targetHeight) * 0.24);
    const hookTop = Math.round(Number(targetHeight) * 0.08);
    const hookFontSize = Math.round(Number(targetWidth) / 17);
    const escapedHookPath = hookText.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const videoFilter = [
      `drawbox=x=48:y=${hookTop}:w=iw-96:h=${hookHeight}:color=0x0F172A@0.88:t=fill:enable='between(t,0,4)'`,
      `drawtext=font='DejaVu Sans':textfile='${escapedHookPath}':expansion=none:fontcolor=white:fontsize=${hookFontSize}:line_spacing=16:x=(w-text_w)/2:y=${hookTop}+(${hookHeight}-text_h)/2:enable='between(t,0,4)'`,
    ].join(',');

    const finalArgs = [
      '-y',
      '-hide_banner',
      '-i',
      normalized,
      '-i',
      voiceMp3,
      '-filter_complex',
      sourceHasAudio
        ? `[0:v]${videoFilter}[vout];[0:a]volume=0.28[bed];[1:a]adelay=350|350,loudnorm=I=-16:TP=-1.5:LRA=11[voice];[bed][voice]amix=inputs=2:duration=first:dropout_transition=2,alimiter=limit=0.95[aout]`
        : `[0:v]${videoFilter}[vout];[1:a]adelay=350|350,loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]`,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      videoPreset,
      '-crf',
      videoCrf,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-shortest',
      processed,
    ];
    await dependencies.run('ffmpeg', finalArgs);

    const [processedBytes, savedVoiceoverBytes] = await Promise.all([
      dependencies.readFile(processed),
      dependencies.readFile(voiceMp3),
    ]);
    const [processedVideoObjectPath, voiceoverObjectPath] = await Promise.all([
      dependencies.saveObject(processedBytes, 'video/mp4', '.mp4'),
      dependencies.saveObject(savedVoiceoverBytes, 'audio/mpeg', '.mp3'),
    ]);

    return { processedVideoObjectPath, voiceoverObjectPath };
  } catch (error) {
    processingError = error;
    throw error;
  } finally {
    try {
      await dependencies.removeTempDir(workingDir);
    } catch (cleanupError) {
      handleTemporaryDirectoryCleanupFailure({
        operationError: processingError,
        cleanupCause: cleanupError,
        workingDir,
        cleanupErrorName: 'MediaProcessingCleanupError',
        contextualMessage:
          'Failed to clean up media processing temporary directory',
        logMessage: 'Failed to clean up media processing temporary directory',
      });
    }
  }
}