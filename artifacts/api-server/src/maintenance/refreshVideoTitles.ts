import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { db, pool, submissionsTable, type Submission } from '@workspace/db';
import { and, eq, inArray } from 'drizzle-orm';

import { objectStorageClient, ObjectStorageService } from '../lib/objectStorage';
import { findTrimWindow } from '../lib/mediaProcessing';
import { durableVideoThumbnail } from '../lib/durableVideoThumbnail';
import {
  buildHookLine,
  buildVideoTitleFilter,
  wrapHookText,
} from '../lib/videoTitleStyle';

type Mode = 'inspect' | 'prepare' | 'apply';

type Probe = {
  durationSeconds: number;
  videoDurationSeconds: number;
  videoFrameCount: number;
  width: number;
  height: number;
  frameRate: string;
  hasAudio: boolean;
};

type AudioPacketEvidence = {
  packetCount: number;
  startSeconds: number;
  endSeconds: number;
  packetSha256: string;
};

type ManifestEntry = {
  id: number;
  videoObjectPath: string;
  processedVideoObjectPath: string;
  updatedAt: string;
  trimStartSeconds: number;
  trimEndSeconds?: number;
  trimOrigin: 'saved-or-detected' | 'verified-detected-historical';
  oldProbe: Probe;
  oldAudioSha256: string;
  oldAudioPackets: AudioPacketEvidence;
  normalizedProbe: Probe;
  footageSsim: number;
  renderedSha256: string;
  renderedFile: string;
  newObjectPath: string;
  state: 'prepared' | 'uploaded' | 'applied';
};

type Manifest = {
  schemaVersion: 3;
  runId: string;
  createdAt: string;
  mode: 'development-title-refresh';
  entries: ManifestEntry[];
};

type CliOptions = {
  mode: Mode;
  ids: number[];
  manifestPath: string;
  workDir: string;
  applyConfirmation?: string;
  recoverDetectedTrim: boolean;
};

const APPLY_CONFIRMATION = 'REFRESH_VIDEO_TITLES_DEV';
const objectStorage = new ObjectStorageService();
const DURATION_TOLERANCE_SECONDS = 0.01;

function fail(message: string): never {
  throw new Error(message);
}

function parseOptions(argv: string[]): CliOptions {
  let mode: Mode = 'inspect';
  let rawIds: string | undefined;
  let manifestPath = resolve('.refresh-video-titles/manifest.json');
  let workDir = resolve('.refresh-video-titles/work');
  let applyConfirmation: string | undefined;
  let recoverDetectedTrim = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'inspect' || argument === 'prepare' || argument === 'apply') {
      mode = argument;
    } else if (argument === '--ids') {
      rawIds = argv[++index];
    } else if (argument === '--manifest') {
      manifestPath = resolve(argv[++index] ?? fail('--manifest requires a path'));
    } else if (argument === '--work-dir') {
      workDir = resolve(argv[++index] ?? fail('--work-dir requires a path'));
    } else if (argument === '--confirm-apply') {
      applyConfirmation = argv[++index];
    } else if (argument === '--recover-detected-trim') {
      recoverDetectedTrim = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }

  if (!rawIds) fail('Explicit submission IDs are required: --ids 1,2');
  const ids = [...new Set(rawIds.split(',').map((value) => Number(value.trim())))];
  if (
    ids.length === 0 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    fail('--ids must be a comma-separated list of positive integer IDs');
  }

  if (recoverDetectedTrim && (mode !== 'prepare' || ids.length !== 1)) {
    fail('--recover-detected-trim is restricted to preparing one explicit ID');
  }
  return { mode, ids, manifestPath, workDir, applyConfirmation, recoverDetectedTrim };
}

function assertDevelopmentEnvironment(): void {
  if (process.env.NODE_ENV !== 'development') {
    fail('This maintenance command only runs when NODE_ENV=development');
  }
}

function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        reject(
          new Error(
            `${command} ${signal ? `terminated by signal ${signal}` : `exited with code ${code}`}: ${stderr.slice(-4_000)}`,
          ),
        );
      }
    });
  });
}

async function probe(file: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,avg_frame_rate,duration,nb_frames',
    '-of',
    'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
      nb_frames?: string;
    }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const durationSeconds = Number(parsed.format?.duration);
  const videoDurationSeconds = Number(video?.duration);
  const videoFrameCount = Number(video?.nb_frames);
  if (
    !video ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !video.width ||
    !video.height ||
    !video.avg_frame_rate ||
    !Number.isFinite(videoDurationSeconds) ||
    videoDurationSeconds <= 0 ||
    !Number.isSafeInteger(videoFrameCount) ||
    videoFrameCount <= 0
  ) {
    fail(`ffprobe returned incomplete video metadata for ${file}`);
  }
  return {
    durationSeconds,
    videoDurationSeconds,
    videoFrameCount,
    width: video.width,
    height: video.height,
    frameRate: video.avg_frame_rate,
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
  };
}

function frameRateNumber(frameRate: string): number {
  const [numerator, denominator = '1'] = frameRate.split('/');
  return Number(numerator) / Number(denominator);
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function audioSha256(input: string, output: string): Promise<string> {
  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-c:a',
    'copy',
    '-f',
    'adts',
    output,
  ]);
  return sha256(output);
}

async function audioPacketEvidence(input: string): Promise<AudioPacketEvidence> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'packet=pts_time,dts_time,duration_time,size,data_hash',
    '-of', 'json', input,
  ]);
  const { packets } = JSON.parse(stdout) as {
    packets?: Array<{
      pts_time: string;
      dts_time: string;
      duration_time: string;
      size: string;
      data_hash: string;
    }>;
  };
  if (!packets?.length || packets.some((packet) =>
    !Number.isFinite(Number(packet.pts_time)) ||
    !Number.isFinite(Number(packet.dts_time)) ||
    !Number.isFinite(Number(packet.duration_time)) ||
    Number(packet.duration_time) <= 0 ||
    !packet.data_hash?.startsWith('SHA256:'))) {
    fail('Existing mixed audio has incomplete packet evidence');
  }
  return {
    packetCount: packets.length,
    startSeconds: Number(packets[0]!.pts_time),
    endSeconds: Math.max(...packets.map((packet) =>
      Number(packet.pts_time) + Number(packet.duration_time))),
    // Verify timestamps and encoded payloads, not just decoded audio/duration.
    packetSha256: createHash('sha256').update(JSON.stringify(packets)).digest('hex'),
  };
}

export function assertHistoricalFrameWindow(
  oldProbe: Probe,
  normalizedProbe: Probe,
  oldAudio: AudioPacketEvidence,
): void {
  const excessFrames = normalizedProbe.videoFrameCount - oldProbe.videoFrameCount;
  const fps = frameRateNumber(oldProbe.frameRate);
  const excessSeconds = normalizedProbe.videoDurationSeconds - oldProbe.videoDurationSeconds;
  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isSafeInteger(excessFrames) ||
    oldProbe.width !== normalizedProbe.width ||
    oldProbe.height !== normalizedProbe.height ||
    oldProbe.frameRate !== normalizedProbe.frameRate ||
    excessFrames < 0 ||
    Math.abs(excessSeconds - excessFrames / fps) > DURATION_TOLERANCE_SECONDS
  ) {
    fail(`Candidate trim does not reconstruct the historical video frame window: old ${oldProbe.videoFrameCount} frames/${oldProbe.videoDurationSeconds}s, candidate ${normalizedProbe.videoFrameCount} frames/${normalizedProbe.videoDurationSeconds}s`);
  }
  if (excessFrames === 0) return;
  // A historical -shortest encode can omit a small tail when mixed audio
  // ends first. Require packet evidence of that boundary and a tightly bounded
  // encoder tail; never interpret a substantial trim mismatch as encoder drift.
  if (
    excessFrames > 8 ||
    oldAudio.endSeconds >= normalizedProbe.videoDurationSeconds ||
    Math.abs(oldAudio.endSeconds - oldProbe.videoDurationSeconds) > 4 / fps ||
    Math.abs(oldAudio.startSeconds) > 1 / fps
  ) {
    fail(`Historical tail cannot be verified: ${excessFrames} extra source frames; old audio ends at ${oldAudio.endSeconds}s`);
  }
}

async function downloadObject(objectPath: string, destination: string): Promise<void> {
  const file = await objectStorage.getObjectEntityFile(objectPath);
  await file.download({ destination });
}

function selectTrim(
  submission: Submission,
  detected: { start: number; end?: number },
): { start: number; end?: number } {
  const start = submission.trimStartSeconds ?? detected.start;
  const end =
    submission.trimEndSeconds !== null &&
    submission.trimEndSeconds !== undefined &&
    submission.trimEndSeconds > start
      ? submission.trimEndSeconds
      : detected.end;
  return { start, end };
}

function assertProbeMatches(expected: Probe, actual: Probe): void {
  if (
    expected.width !== actual.width ||
    expected.height !== actual.height ||
    expected.frameRate !== actual.frameRate ||
    expected.videoFrameCount !== actual.videoFrameCount ||
    Math.abs(expected.videoDurationSeconds - actual.videoDurationSeconds) >
      DURATION_TOLERANCE_SECONDS ||
    expected.hasAudio !== actual.hasAudio ||
    Math.abs(expected.durationSeconds - actual.durationSeconds) >
      DURATION_TOLERANCE_SECONDS
  ) {
    fail(
      `Rendered media mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

async function assertFootageMatches(
  normalizedFile: string,
  oldFile: string,
  comparisonDurationSeconds: number,
  submissionId: number,
): Promise<number> {
  const lowerCrop =
    'crop=iw:trunc(ih*0.55/2)*2:0:ih-oh';
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-i',
    normalizedFile,
    '-i',
    oldFile,
    '-t',
    comparisonDurationSeconds.toFixed(6),
    '-filter_complex',
    `[0:v]${lowerCrop},setpts=PTS-STARTPTS[candidate];[1:v]${lowerCrop},setpts=PTS-STARTPTS[old];[candidate][old]ssim=shortest=1`,
    '-an',
    '-f',
    'null',
    '-',
  ]);
  const score = Number(
    [...stderr.matchAll(/SSIM.*All:([\d.]+)/g)].at(-1)?.[1],
  );
  if (!Number.isFinite(score)) {
    fail(`Submission ${submissionId}: ffmpeg did not report an SSIM score`);
  }
  if (score < 0.95) {
    fail(
      `Submission ${submissionId}: normalized footage SSIM ${score.toFixed(6)} is below 0.95`,
    );
  }
  return score;
}

async function renderEntry(
  submission: Submission,
  entryDir: string,
  newObjectPath: string,
  recoverDetectedTrim = false,
): Promise<ManifestEntry> {
  await mkdir(entryDir, { recursive: true });
  const originalFile = join(entryDir, 'original');
  const oldFile = join(entryDir, 'old-processed.mp4');
  const normalizedFile = join(entryDir, 'normalized.mp4');
  const renderedFile = join(entryDir, 'refreshed.mp4');
  const oldAudioFile = join(entryDir, 'old-audio.bin');
  const newAudioFile = join(entryDir, 'new-audio.bin');
  const titleFile = join(entryDir, 'title.txt');
  await Promise.all([
    downloadObject(submission.videoObjectPath, originalFile),
    downloadObject(submission.processedVideoObjectPath!, oldFile),
  ]);

  const oldProbe = await probe(oldFile);
  if (!oldProbe.hasAudio) fail(`Submission ${submission.id}: old output has no audio`);
  if (Math.abs(frameRateNumber(oldProbe.frameRate) - 30) > 0.0001) {
    fail(`Submission ${submission.id}: old output is not 30fps`);
  }
  const detectedTrim = await findTrimWindow(originalFile);
  // Recovery is an explicit maintenance-only request. A newly detected window
  // is only a candidate: the exact historical frame/audio boundary checks and
  // every-frame footage SSIM below remain mandatory. Never change saved trims.
  const trim = recoverDetectedTrim ? detectedTrim : selectTrim(submission, detectedTrim);
  const oldAudioSha256 = await audioSha256(oldFile, oldAudioFile);
  const oldAudioPackets = await audioPacketEvidence(oldFile);
  await writeFile(
    titleFile,
    wrapHookText(buildHookLine(submission), oldProbe.width),
    { mode: 0o600 },
  );

  const renderArgs = ['-y', '-hide_banner'];
  if (trim.start > 0) renderArgs.push('-ss', trim.start.toFixed(2));
  renderArgs.push('-i', originalFile);
  if (trim.end !== undefined) {
    renderArgs.push('-t', (trim.end - trim.start).toFixed(2));
  }
  renderArgs.push(
    '-vf',
    `scale=${oldProbe.width}:${oldProbe.height}:force_original_aspect_ratio=decrease,pad=${oldProbe.width}:${oldProbe.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    '-map',
    '0:v:0',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    process.env.VIDEO_PRESET ?? 'medium',
    '-crf',
    process.env.VIDEO_CRF ?? '20',
    '-r',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    normalizedFile,
  );
  await run('ffmpeg', renderArgs);

  const normalizedProbe = await probe(normalizedFile);
  assertHistoricalFrameWindow(oldProbe, normalizedProbe, oldAudioPackets);
  const footageSsim = await assertFootageMatches(
    normalizedFile,
    oldFile,
    oldProbe.videoDurationSeconds,
    submission.id,
  );

  const titleFilter = buildVideoTitleFilter({
    hookTextPath: titleFile,
    targetWidth: oldProbe.width,
    targetHeight: oldProbe.height,
  });
  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-i',
    normalizedFile,
    '-i',
    oldFile,
    '-vf',
    `${titleFilter},trim=end_frame=${oldProbe.videoFrameCount}`,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    process.env.VIDEO_PRESET ?? 'medium',
    '-crf',
    process.env.VIDEO_CRF ?? '20',
    '-c:a',
    'copy',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    renderedFile,
  ]);
  const renderedProbe = await probe(renderedFile);
  assertProbeMatches(oldProbe, renderedProbe);
  const newAudioSha256 = await audioSha256(renderedFile, newAudioFile);
  if (newAudioSha256 !== oldAudioSha256) {
    fail(`Submission ${submission.id}: copied audio hash does not match old output`);
  }
  if ((await audioPacketEvidence(renderedFile)).packetSha256 !== oldAudioPackets.packetSha256) {
    fail(`Submission ${submission.id}: mixed audio packet payloads/timestamps changed`);
  }

  return {
    id: submission.id,
    videoObjectPath: submission.videoObjectPath,
    processedVideoObjectPath: submission.processedVideoObjectPath!,
    updatedAt: submission.updatedAt.toISOString(),
    trimStartSeconds: trim.start,
    ...(trim.end === undefined ? {} : { trimEndSeconds: trim.end }),
    trimOrigin: recoverDetectedTrim ? 'verified-detected-historical' : 'saved-or-detected',
    oldProbe,
    oldAudioSha256,
    oldAudioPackets,
    normalizedProbe,
    footageSsim,
    renderedSha256: await sha256(renderedFile),
    renderedFile,
    newObjectPath,
    state: 'prepared',
  };
}

async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const handle = await open(temporaryPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function loadManifest(path: string): Promise<Manifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Manifest;
  if (
    value.schemaVersion !== 3 ||
    value.mode !== 'development-title-refresh' ||
    !Array.isArray(value.entries)
  ) {
    fail('Manifest is invalid or has an unsupported schema');
  }
  return value;
}

async function eligibleSubmissions(ids: number[]): Promise<Submission[]> {
  const rows = await db
    .select()
    .from(submissionsTable)
    .where(
      and(
        inArray(submissionsTable.id, ids),
        eq(submissionsTable.status, 'approved'),
        eq(submissionsTable.processingStatus, 'completed'),
      ),
    );
  const foundIds = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    fail(
      `IDs are missing or are not approved/completed: ${missing.join(', ')}`,
    );
  }
  for (const row of rows) {
    if (!row.processedVideoObjectPath) {
      fail(`Submission ${row.id} has no processed video`);
    }
  }
  return rows;
}

async function inspect(ids: number[]): Promise<void> {
  const rows = await eligibleSubmissions(ids);
  const result = rows.map((row) => ({
    id: row.id,
    status: row.status,
    processingStatus: row.processingStatus,
    hasOriginal: Boolean(row.videoObjectPath),
    hasProcessed: Boolean(row.processedVideoObjectPath),
    hasTrimOverride:
      row.trimStartSeconds !== null || row.trimEndSeconds !== null,
    updatedAt: row.updatedAt.toISOString(),
  }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function prepare(options: CliOptions): Promise<void> {
  const submissions = await eligibleSubmissions(options.ids);
  const runId = randomUUID();
  const entries: ManifestEntry[] = [];
  for (const submission of submissions) {
    const newObjectPath =
      `/objects/automation/title-refresh-${runId}-${submission.id}.mp4`;
    entries.push(
      await renderEntry(
        submission,
        join(options.workDir, runId, String(submission.id)),
        newObjectPath,
        options.recoverDetectedTrim,
      ),
    );
  }
  const manifest: Manifest = {
    schemaVersion: 3,
    runId,
    createdAt: new Date().toISOString(),
    mode: 'development-title-refresh',
    entries,
  };
  await writeManifest(options.manifestPath, manifest);
  process.stdout.write(
    `Prepared ${entries.length} clip(s); no objects uploaded and no database rows changed.\n`,
  );
}

function objectFileForPath(objectPath: string) {
  if (!objectPath.startsWith('/objects/')) fail('Invalid manifest object path');
  const privateDir = objectStorage.getPrivateObjectDir().replace(/\/+$/, '');
  const [bucketName, ...prefixParts] = privateDir.replace(/^\/+/, '').split('/');
  if (!bucketName) fail('PRIVATE_OBJECT_DIR has no bucket name');
  const entityId = objectPath.slice('/objects/'.length);
  return objectStorageClient
    .bucket(bucketName)
    .file([...prefixParts, entityId].filter(Boolean).join('/'));
}

async function uploadOrVerify(entry: ManifestEntry): Promise<void> {
  if ((await sha256(entry.renderedFile)) !== entry.renderedSha256) {
    fail(`Submission ${entry.id}: prepared file hash does not match manifest`);
  }
  assertProbeMatches(entry.oldProbe, await probe(entry.renderedFile));
  assertHistoricalFrameWindow(entry.oldProbe, entry.normalizedProbe, entry.oldAudioPackets);
  if (!Number.isFinite(entry.footageSsim) || entry.footageSsim < 0.95) {
    fail(`Submission ${entry.id}: manifest has no validated footage match`);
  }
  if ((await audioPacketEvidence(entry.renderedFile)).packetSha256 !== entry.oldAudioPackets.packetSha256) {
    fail(`Submission ${entry.id}: prepared mixed audio packet evidence changed`);
  }
  const audioCheckFile = `${entry.renderedFile}.audio-check-${process.pid}`;
  try {
    if ((await audioSha256(entry.renderedFile, audioCheckFile)) !== entry.oldAudioSha256) {
      fail(`Submission ${entry.id}: prepared audio no longer matches old output`);
    }
  } finally {
    await rm(audioCheckFile, { force: true });
  }
  const file = objectFileForPath(entry.newObjectPath);
  const [exists] = await file.exists();
  if (exists) {
    const [bytes] = await file.download();
    if (
      createHash('sha256').update(bytes).digest('hex') !== entry.renderedSha256
    ) {
      fail(`Submission ${entry.id}: destination object exists with other bytes`);
    }
    return;
  }
  await file.save(await readFile(entry.renderedFile), {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType: 'video/mp4',
      cacheControl: 'private, max-age=3600',
    },
  });
}

async function apply(options: CliOptions): Promise<void> {
  if (options.applyConfirmation !== APPLY_CONFIRMATION) {
    fail(`apply requires --confirm-apply ${APPLY_CONFIRMATION}`);
  }
  const manifest = await loadManifest(options.manifestPath);
  const manifestIds = manifest.entries.map((entry) => entry.id).sort((a, b) => a - b);
  const requestedIds = [...options.ids].sort((a, b) => a - b);
  if (JSON.stringify(manifestIds) !== JSON.stringify(requestedIds)) {
    fail('Explicit --ids must exactly match the manifest IDs');
  }

  for (const entry of manifest.entries) {
    if (entry.state === 'applied') continue;
    if (entry.state === 'prepared') {
      await uploadOrVerify(entry);
      entry.state = 'uploaded';
      await writeManifest(options.manifestPath, manifest);
    } else {
      await uploadOrVerify(entry);
    }

    // Prepare the replacement's private thumbnail before publishing its path.
    await durableVideoThumbnail(entry.newObjectPath, objectFileForPath(entry.newObjectPath));

    const updated = await db
      .update(submissionsTable)
      .set({
        processedVideoObjectPath: entry.newObjectPath,
        // Cosmetic media replacement must not reorder the homepage showcase.
        updatedAt: new Date(entry.updatedAt),
      })
      .where(
        and(
          eq(submissionsTable.id, entry.id),
          eq(submissionsTable.status, 'approved'),
          eq(submissionsTable.processingStatus, 'completed'),
          eq(submissionsTable.videoObjectPath, entry.videoObjectPath),
          eq(
            submissionsTable.processedVideoObjectPath,
            entry.processedVideoObjectPath,
          ),
          eq(submissionsTable.updatedAt, new Date(entry.updatedAt)),
        ),
      )
      .returning({ id: submissionsTable.id });
    if (updated.length !== 1) {
      const [current] = await db
        .select({
          status: submissionsTable.status,
          processingStatus: submissionsTable.processingStatus,
          videoObjectPath: submissionsTable.videoObjectPath,
          processedVideoObjectPath: submissionsTable.processedVideoObjectPath,
        })
        .from(submissionsTable)
        .where(eq(submissionsTable.id, entry.id))
        .limit(1);
      const alreadyApplied =
        current?.status === 'approved' &&
        current.processingStatus === 'completed' &&
        current.videoObjectPath === entry.videoObjectPath &&
        current.processedVideoObjectPath === entry.newObjectPath;
      if (!alreadyApplied) {
        fail(
          `Submission ${entry.id}: optimistic update failed; uploaded object was preserved for recovery`,
        );
      }
    }
    entry.state = 'applied';
    await writeManifest(options.manifestPath, manifest);
  }
  process.stdout.write(`Applied ${manifest.entries.length} clip refresh(es).\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  assertDevelopmentEnvironment();
  if (options.mode === 'inspect') await inspect(options.ids);
  else if (options.mode === 'prepare') await prepare(options);
  else await apply(options);
}

if (process.argv[1]?.endsWith('refreshVideoTitles.mjs')) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}