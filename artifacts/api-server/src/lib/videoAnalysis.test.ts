import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeSubmissionVideo, type VideoAnalysis } from "./videoAnalysis";

const submission = {
  videoObjectPath: "/videos/dog.mp4",
  dogName: "Scout",
  trickName: "Spin",
  trickDescription: "Scout spins in a circle",
} as Parameters<typeof analyzeSubmissionVideo>[0];

function response(analysis: VideoAnalysis) {
  return { text: JSON.stringify(analysis) };
}

function createHarness(
  duration: number | string,
  results: Array<VideoAnalysis | Error>,
  overrides: {
    ffmpegError?: Error;
    previewBytes?: Buffer;
    removeTempDirError?: Error;
  } = {},
) {
  const ffmpegDurations: number[] = [];
  const ffmpegStarts: number[] = [];
  const progress: Array<[number, number]> = [];
  const removedTempDirs: string[] = [];
  let generateCalls = 0;
  let resultIndex = 0;

  const dependencies = {
    getSourceBytes: async () => Buffer.from("source"),
    makeTempDir: async () => "/tmp/video-analysis-test",
    removeTempDir: async (path: string) => {
      removedTempDirs.push(path);
      if (overrides.removeTempDirError) throw overrides.removeTempDirError;
    },
    writeFile: async () => undefined,
    readFile: async () => overrides.previewBytes ?? Buffer.from("preview"),
    waitForRateLimit: async () => undefined,
    retryDelay: async () => undefined,
    run: async (command: string, args: string[]) => {
      if (command === "ffprobe") return { stdout: String(duration), stderr: "" };
      ffmpegStarts.push(Number(args[args.indexOf("-ss") + 1]));
      ffmpegDurations.push(Number(args[args.indexOf("-t") + 1]));
      if (overrides.ffmpegError) throw overrides.ffmpegError;
      return { stdout: "", stderr: "" };
    },
    generateContent: async () => {
      generateCalls += 1;
      const result = results[resultIndex++];
      if (result instanceof Error) throw result;
      return response(result);
    },
  };

  return {
    dependencies,
    ffmpegDurations,
    ffmpegStarts,
    progress,
    removedTempDirs,
    generateCalls: () => generateCalls,
    onProgress: async (completed: number, total: number) => {
      progress.push([completed, total]);
    },
  };
}

const lowConfidence: VideoAnalysis = {
  trimStartSeconds: 10,
  trimEndSeconds: 20,
  detectedAction: "Scout prepares to spin",
  punchlines: ["Warming up the whirl"],
  confidence: 0.4,
};

describe("analyzeSubmissionVideo", () => {
  for (const duration of ["not-a-duration", "0", "-1"]) {
    it(`rejects invalid ffprobe duration "${duration}" and cleans up`, async () => {
      const harness = createHarness(duration, []);

      await assert.rejects(
        analyzeSubmissionVideo(submission, undefined, harness.dependencies),
        /Could not determine the uploaded video's duration/,
      );
      assert.deepEqual(harness.removedTempDirs, ["/tmp/video-analysis-test"]);
      assert.equal(harness.generateCalls(), 0);
    });
  }

  it("preserves ffmpeg failures and cleans up", async () => {
    const ffmpegError = new Error("ffmpeg exited with code 1: invalid video stream");
    const harness = createHarness(10, [], { ffmpegError });

    await assert.rejects(
      analyzeSubmissionVideo(submission, undefined, harness.dependencies),
      /ffmpeg exited with code 1: invalid video stream/,
    );
    assert.deepEqual(harness.removedTempDirs, ["/tmp/video-analysis-test"]);
    assert.equal(harness.generateCalls(), 0);
  });

  it("preserves the processing failure when temporary-directory cleanup also fails", async () => {
    const ffmpegError = new Error("ffmpeg exited with code 1: invalid video stream");
    const cleanupError = new Error("temporary directory is busy");
    const harness = createHarness(10, [], { ffmpegError, removeTempDirError: cleanupError });
    const loggedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    try {
      await assert.rejects(
        analyzeSubmissionVideo(submission, undefined, harness.dependencies),
        (error: Error & { cleanupError?: Error }) => {
          assert.equal(error, ffmpegError);
          assert.equal(error.cleanupError?.name, "VideoAnalysisCleanupError");
          assert.equal(
            error.cleanupError?.message,
            "Failed to clean up video analysis temporary directory: /tmp/video-analysis-test",
          );
          assert.equal(error.cleanupError?.cause, cleanupError);
          return true;
        },
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.deepEqual(harness.removedTempDirs, ["/tmp/video-analysis-test"]);
    assert.deepEqual(loggedErrors, [[
      "Failed to clean up video analysis temporary directory",
      (ffmpegError as Error & { cleanupError?: Error }).cleanupError,
    ]]);
  });

  it("surfaces a temporary-directory cleanup failure after successful processing", async () => {
    const cleanupError = new Error("temporary directory is busy");
    const successfulAnalysis: VideoAnalysis = {
      ...lowConfidence,
      trimStartSeconds: 1,
      trimEndSeconds: 5,
    };
    const harness = createHarness(10, [successfulAnalysis], {
      removeTempDirError: cleanupError,
    });

    await assert.rejects(
      analyzeSubmissionVideo(submission, undefined, harness.dependencies),
      (error: Error) => {
        assert.equal(error.name, "VideoAnalysisCleanupError");
        assert.equal(
          error.message,
          "Failed to clean up video analysis temporary directory: /tmp/video-analysis-test",
        );
        assert.equal(error.cause, cleanupError);
        return true;
      },
    );

    assert.equal(harness.generateCalls(), 1);
    assert.deepEqual(harness.removedTempDirs, ["/tmp/video-analysis-test"]);
  });

  it("rejects compressed chunks above Gemini's inline limit and cleans up", async () => {
    const oversizedPreview = Buffer.alloc(8 * 1024 * 1024 + 1);
    const harness = createHarness(10, [], { previewBytes: oversizedPreview });

    await assert.rejects(
      analyzeSubmissionVideo(submission, undefined, harness.dependencies),
      /Compressed analysis chunk 1 exceeds Gemini's 8 MB inline limit/,
    );
    assert.deepEqual(harness.removedTempDirs, ["/tmp/video-analysis-test"]);
    assert.equal(harness.generateCalls(), 0);
  });

  for (const [duration, expectedDurations] of [
    [59.9, [59.9]],
    [60, [60]],
    [60.1, [60, 0.1]],
  ] as const) {
    it(`creates exact chunks for a ${duration}-second video`, async () => {
      const analyses = expectedDurations.map((chunkDuration) => ({
        ...lowConfidence,
        trimStartSeconds: 0,
        trimEndSeconds: chunkDuration,
      }));
      const harness = createHarness(
        duration,
        analyses,
      );

      await analyzeSubmissionVideo(
        submission,
        harness.onProgress,
        harness.dependencies,
      );

      assert.deepEqual(harness.ffmpegDurations, expectedDurations);
      assert.deepEqual(
        harness.progress,
        [
          [0, expectedDurations.length],
          ...expectedDurations.map((_, index) => [
            index + 1,
            expectedDurations.length,
          ]),
        ],
      );
    });
  }

  it("rejects a final-chunk timestamp beyond the final boundary", async () => {
    const harness = createHarness(60.1, [
      lowConfidence,
      {
        ...lowConfidence,
        trimStartSeconds: 0,
        trimEndSeconds: 0.2,
      },
      {
        ...lowConfidence,
        trimStartSeconds: 0,
        trimEndSeconds: 0.2,
      },
      {
        ...lowConfidence,
        trimStartSeconds: 0,
        trimEndSeconds: 0.2,
      },
    ]);

    await assert.rejects(
      analyzeSubmissionVideo(submission, undefined, harness.dependencies),
      /incomplete video analysis/,
    );
    assert.equal(harness.generateCalls(), 4);
  });

  it("analyzes every chunk, retries Gemini, offsets timestamps, and picks the highest confidence", async () => {
    const winner: VideoAnalysis = {
      trimStartSeconds: 2,
      trimEndSeconds: 8,
      detectedAction: "Scout completes the best spin",
      punchlines: ["That spin wins"],
      confidence: 0.95,
    };
    const harness = createHarness(130, [
      new Error("temporary Gemini failure"),
      lowConfidence,
      winner,
      {
        ...lowConfidence,
        trimStartSeconds: 1,
        trimEndSeconds: 9,
        confidence: 0.7,
      },
    ]);

    const result = await analyzeSubmissionVideo(
      submission,
      harness.onProgress,
      harness.dependencies,
    );

    assert.equal(harness.generateCalls(), 4);
    assert.deepEqual(harness.ffmpegStarts, [0, 60, 120]);
    assert.deepEqual(harness.ffmpegDurations, [60, 60, 10]);
    assert.deepEqual(harness.progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
    assert.deepEqual(result, {
      ...winner,
      trimStartSeconds: 62,
      trimEndSeconds: 68,
    });
  });
});