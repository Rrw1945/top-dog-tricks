import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Submission } from '@workspace/db';
import { textToSpeech } from '@workspace/integrations-openai-ai-server/audio';
import { ObjectStorageService } from './objectStorage';
import { persistVideoThumbnail } from './durableVideoThumbnail';
import {
  handleTemporaryDirectoryCleanupFailure,
  type ErrorWithCleanupFailure,
} from './temporaryDirectoryCleanup';
import {
  buildHookLine,
  buildVideoTitleFilter,
  wrapHookText,
} from './videoTitleStyle';

const objectStorage = new ObjectStorageService();
const VOICEOVER_WORD_LIMIT = 24;

type MediaProcessingDependencies = {
  persistThumbnail: typeof persistVideoThumbnail;
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

export function buildVoiceoverScript(
  submission: Pick<Submission, 'dogName' | 'trickName' | 'trickDescription'>,
): string {
  const dogName = submission.dogName.trim().replace(/[.!?]+$/, '');
  const whatHappens = submission.trickDescription.trim() || submission.trickName.trim();
  const words = `This is ${dogName}. ${whatHappens}`.trim().split(/\s+/);

  if (words.length <= VOICEOVER_WORD_LIMIT) {
    return words.join(' ');
  }

  return `${words.slice(0, VOICEOVER_WORD_LIMIT).join(' ').replace(/[,:;.!?]+$/, '')}…`;
}

export function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    // ffmpeg progress can be very verbose on long uploads. Keep only the
    // diagnostics needed for failures instead of buffering its entire log.
    child.stdout.on('data', (chunk) => (stdout = (stdout + chunk).slice(-65536)));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-16384)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        `${command} ${signal ? `terminated by signal ${signal}` : `exited with code ${code}`}: ${stderr.slice(-4000)}`,
      ));
    });
  });
}

function durationFromProbe(stderr: string): number {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export async function findTrimWindow(
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
  const detectedStart = starts[0] !== undefined && starts[0] < 0.75 && ends[0] !== undefined ? ends[0] : 0;
  // Silence may span the entire soundtrack while the video still contains
  // useful action. Never auto-trim away all (or nearly all) of the footage.
  if (duration <= 0 || duration - detectedStart < 1) return { start: 0 };
  const start = detectedStart;
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

async function videoDuration(input: string, runCommand: typeof run): Promise<number> {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Normalized video has no valid video duration: ${stdout.trim() || '(empty)'}`);
  }
  return duration;
}

export async function processSubmissionMedia(
  submission: Submission,
  dependencyOverrides?: Partial<MediaProcessingDependencies>,
): Promise<{
  processedVideoObjectPath: string;
  voiceoverObjectPath: string;
}> {
  const dependencies: MediaProcessingDependencies = {
    persistThumbnail: persistVideoThumbnail,
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
    // Validate/write the shared saved-punchline overlay before any paid speech.
    const targetWidth = process.env.VIDEO_TARGET_WIDTH ?? '1080';
    await dependencies.writeFile(
      hookText,
      wrapHookText(buildHookLine(submission), Number(targetWidth)),
    );
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
    // Trimming can remove all source audio packets even when the original
    // container advertises an audio track. Mix only streams that survived.
    const normalizedHasAudio = await hasAudioStream(normalized, dependencies.run);
    const normalizedVideoDuration = await videoDuration(normalized, dependencies.run);

    const script = buildVoiceoverScript(submission);
    const voiceoverBytes = await dependencies.textToSpeech(
      script,
      'echo',
      'mp3',
      'Use an original younger-sounding adult male voice with bright, friendly enthusiasm. Sound genuinely excited to share this dog’s trick. Speak clearly at a lively but comfortable pace, with natural pauses and a warm smile. Keep the delivery conversational and easy to understand, never rushed, shouting, or exaggerated like a sales announcer. Do not imitate or impersonate any real person.',
    );
    if (voiceoverBytes.length === 0) {
      throw new Error('Professional voiceover service returned empty audio');
    }
    await dependencies.writeFile(voiceMp3, voiceoverBytes);

    const videoFilter = buildVideoTitleFilter({
      hookTextPath: hookText,
      targetWidth: Number(targetWidth),
      targetHeight: Number(targetHeight),
    });

    const finalArgs = [
      '-y',
      '-hide_banner',
      '-i',
      normalized,
      '-i',
      voiceMp3,
      '-filter_complex',
      normalizedHasAudio
        ? `[0:v]${videoFilter}[vout];[0:a]volume=0.28[bed];[1:a]adelay=350|350,loudnorm=I=-16:TP=-1.5:LRA=11[voice];[bed][voice]amix=inputs=2:duration=first:dropout_transition=2,alimiter=limit=0.95[aout]`
        : `[0:v]${videoFilter}[vout];[1:a]adelay=350|350,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=duration=${normalizedVideoDuration}[aout]`,
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
      processed,
    ];
    await dependencies.run('ffmpeg', finalArgs);

    const thumbnail = join(workingDir, 'preview.jpg');
    await dependencies.run('ffmpeg', [
      '-nostdin', '-v', 'error', '-threads', '1', '-i', processed,
      '-vf', 'thumbnail=15,scale=480:-2', '-frames:v', '1',
      '-threads', '1', '-y', thumbnail,
    ]);

    const [processedBytes, savedVoiceoverBytes] = await Promise.all([
      dependencies.readFile(processed),
      dependencies.readFile(voiceMp3),
    ]);
    const [processedVideoObjectPath, voiceoverObjectPath] = await Promise.all([
      dependencies.saveObject(processedBytes, 'video/mp4', '.mp4'),
      dependencies.saveObject(savedVoiceoverBytes, 'audio/mpeg', '.mp3'),
    ]);
    await dependencies.persistThumbnail(processedVideoObjectPath, await dependencies.readFile(thumbnail));

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