import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Submission } from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import { batchProcess } from "@workspace/integrations-gemini-ai/batch";
import { ObjectStorageService } from "./objectStorage";
import {
  handleTemporaryDirectoryCleanupFailure,
  type ErrorWithCleanupFailure,
} from "./temporaryDirectoryCleanup";

const objectStorage = new ObjectStorageService();
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const CHUNK_SECONDS = 60;
let nextAnalysisAt = 0;
let rateLimitQueue = Promise.resolve();

type AnalysisDependencies = {
  getSourceBytes: (objectPath: string) => Promise<Buffer>;
  makeTempDir: () => Promise<string>;
  removeTempDir: (path: string) => Promise<void>;
  readFile: (path: string) => Promise<Buffer>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  run: typeof run;
  generateContent: (
    request: Parameters<typeof ai.models.generateContent>[0],
  ) => Promise<{ text?: string }>;
  waitForRateLimit: () => Promise<void>;
  retryDelay: (milliseconds: number) => Promise<void>;
};

export type VideoAnalysis = {
  trimStartSeconds: number;
  trimEndSeconds: number;
  detectedAction: string;
  punchlines: string[];
  confidence: number;
};

export type VideoAnalysisError = ErrorWithCleanupFailure;

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function waitForRateLimit(): Promise<void> {
  const reservation = rateLimitQueue.then(async () => {
    const delay = Math.max(0, nextAnalysisAt - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    nextAnalysisAt = Date.now() + 1_500;
  });
  rateLimitQueue = reservation.catch(() => undefined);
  await reservation;
}

function parseAnalysis(text: string, chunkDurationSeconds: number): VideoAnalysis {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const trimStartSeconds = Number(raw.trimStartSeconds);
  const trimEndSeconds = Number(raw.trimEndSeconds);
  const detectedAction = String(raw.detectedAction ?? "").trim();
  const confidence = Math.min(1, Math.max(0, Number(raw.confidence)));
  const punchlines = Array.isArray(raw.punchlines)
    ? raw.punchlines.map(String).map((line) => line.trim()).filter(Boolean).slice(0, 3)
    : [];

  if (
    !Number.isFinite(trimStartSeconds) ||
    !Number.isFinite(trimEndSeconds) ||
    trimStartSeconds < 0 ||
    trimEndSeconds <= trimStartSeconds ||
    trimStartSeconds >= chunkDurationSeconds ||
    trimEndSeconds > chunkDurationSeconds ||
    !detectedAction ||
    !Number.isFinite(confidence) ||
    punchlines.length === 0
  ) {
    throw new Error("Gemini returned an incomplete video analysis");
  }

  return {
    trimStartSeconds,
    trimEndSeconds,
    detectedAction,
    confidence,
    punchlines,
  };
}

async function requestAnalysis(
  submission: Submission,
  previewBytes: Buffer,
  chunkStartSeconds: number,
  chunkDurationSeconds: number,
  dependencies: AnalysisDependencies,
): Promise<VideoAnalysis> {
  const prompt = `You are assisting a human editor for a friendly dog-trick contest.

Analyze the attached compressed preview and return JSON only.

Owner-provided context:
- Dog: ${submission.dogName}
- Trick name: ${submission.trickName}
- What happens: ${submission.trickDescription}

Find the tight action window that preserves a brief natural lead-in and reaction after the trick. Timestamps are seconds from the beginning of this preview. This preview starts at ${chunkStartSeconds.toFixed(1)} seconds in the original upload.

Return exactly:
{
  "trimStartSeconds": number,
  "trimEndSeconds": number,
  "detectedAction": "one clear sentence describing what is visibly happening",
  "punchlines": ["short option 1", "short option 2", "short option 3"],
  "confidence": number between 0 and 1
}

Punchlines must be warm, playful, brand-safe, under 12 words, and grounded in both the visible action and the owner's description. Never invent an action that is not visible.
If the owner's described trick is not visible in this preview, describe the closest visible action without inventing the trick and assign a low confidence.`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await dependencies.waitForRateLimit();
      const response = await dependencies.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "video/mp4",
                data: previewBytes.toString("base64"),
              },
            },
          ],
        }],
        config: { responseMimeType: "application/json" },
      });
      return parseAnalysis(response.text ?? "", chunkDurationSeconds);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await dependencies.retryDelay(1_500 * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Gemini video analysis failed");
}

export async function analyzeSubmissionVideo(
  submission: Submission,
  onProgress?: (completed: number, total: number) => Promise<void>,
  dependencyOverrides: Partial<AnalysisDependencies> = {},
): Promise<VideoAnalysis> {
  const dependencies: AnalysisDependencies = {
    getSourceBytes: async (objectPath) => {
      const source = await objectStorage.getObjectEntityFile(objectPath);
      const [sourceBytes] = await source.download();
      return sourceBytes;
    },
    makeTempDir: () => mkdtemp(join(tmpdir(), "top-dog-analysis-")),
    removeTempDir: (path) => rm(path, { recursive: true, force: true }),
    readFile,
    writeFile,
    run,
    generateContent: ai.models.generateContent.bind(ai.models),
    waitForRateLimit,
    retryDelay: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...dependencyOverrides,
  };
  const workingDir = await dependencies.makeTempDir();
  const inputPath = join(workingDir, "input");
  let analysisError: unknown;

  try {
    const sourceBytes = await dependencies.getSourceBytes(submission.videoObjectPath);
    await dependencies.writeFile(inputPath, sourceBytes);
    const { stdout: durationText } = await dependencies.run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const durationSeconds = Number(durationText.trim());
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("Could not determine the uploaded video's duration");
    }

    const chunks = Array.from(
      { length: Math.max(1, Math.ceil(durationSeconds / CHUNK_SECONDS)) },
      (_, index) => ({ index, startSeconds: index * CHUNK_SECONDS }),
    );
    await onProgress?.(0, chunks.length);

    const analyses = await batchProcess(
      chunks,
      async (chunk) => {
        const chunkDurationSeconds = Math.min(
          CHUNK_SECONDS,
          Number((durationSeconds - chunk.startSeconds).toFixed(6)),
        );
        const previewPath = join(workingDir, `analysis-preview-${chunk.index}.mp4`);
        await dependencies.run("ffmpeg", [
          "-y",
          "-hide_banner",
          "-ss",
          String(chunk.startSeconds),
          "-i",
          inputPath,
          "-t",
          String(chunkDurationSeconds),
          "-vf",
          "scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2:color=black",
          "-r",
          "12",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-b:v",
          "420k",
          "-maxrate",
          "500k",
          "-bufsize",
          "1000k",
          "-c:a",
          "aac",
          "-b:a",
          "48k",
          "-movflags",
          "+faststart",
          previewPath,
        ]);
        const previewBytes = await dependencies.readFile(previewPath);
        if (previewBytes.length > MAX_INLINE_BYTES) {
          throw new Error(`Compressed analysis chunk ${chunk.index + 1} exceeds Gemini's 8 MB inline limit`);
        }
        const analysis = await requestAnalysis(
          submission,
          previewBytes,
          chunk.startSeconds,
          chunkDurationSeconds,
          dependencies,
        );
        const completed = chunk.index + 1;
        await onProgress?.(completed, chunks.length);
        return {
          ...analysis,
          trimStartSeconds: chunk.startSeconds + analysis.trimStartSeconds,
          trimEndSeconds: chunk.startSeconds + analysis.trimEndSeconds,
        };
      },
      { concurrency: 1, retries: 5, minTimeout: 2_000, maxTimeout: 30_000 },
    );

    return analyses.reduce((best, current) =>
      current.confidence > best.confidence ? current : best,
    );
  } catch (error) {
    analysisError = error;
    throw error;
  } finally {
    try {
      await dependencies.removeTempDir(workingDir);
    } catch (cleanupError) {
      handleTemporaryDirectoryCleanupFailure({
        operationError: analysisError,
        cleanupCause: cleanupError,
        workingDir,
        cleanupErrorName: "VideoAnalysisCleanupError",
        contextualMessage:
          "Failed to clean up video analysis temporary directory",
        logMessage: "Failed to clean up video analysis temporary directory",
      });
    }
  }
}