import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processSubmissionMedia } from './mediaProcessing';

const submission = {
  videoObjectPath: '/videos/dog.mp4',
  dogName: 'Scout',
  trickName: 'Spin',
  trickDescription: 'Scout spins in a circle',
  trimStartSeconds: null,
  trimEndSeconds: null,
} as Parameters<typeof processSubmissionMedia>[0];

function createHarness(options: {
  processingError?: Error;
  cleanupError?: Error;
} = {}) {
  const removedTempDirs: string[] = [];
  const dependencies = {
    getSourceBytes: async () => {
      if (options.processingError) throw options.processingError;
      return Buffer.from('source');
    },
    makeTempDir: async () => '/tmp/media-processing-test',
    removeTempDir: async (path: string) => {
      removedTempDirs.push(path);
      if (options.cleanupError) throw options.cleanupError;
    },
    readFile: async (path: string) =>
      Buffer.from(path.endsWith('voice.mp3') ? 'voice' : 'video'),
    writeFile: async () => undefined,
    run: async (command: string) => {
      if (command === 'ffprobe') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: 'Duration: 00:00:10.00' };
    },
    textToSpeech: async () => Buffer.from('voice'),
    saveObject: async (_data: Buffer, contentType: string) =>
      contentType === 'video/mp4' ? '/processed/video.mp4' : '/voiceovers/voice.mp3',
  };
  return { dependencies, removedTempDirs };
}

describe('processSubmissionMedia cleanup', () => {
  it('preserves the processing failure when temporary-directory cleanup also fails', async () => {
    const processingError = new Error('could not download source video');
    const cleanupError = new Error('temporary directory is busy');
    const harness = createHarness({ processingError, cleanupError });
    const loggedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => loggedErrors.push(args);

    try {
      await assert.rejects(
        processSubmissionMedia(submission, harness.dependencies),
        (error: Error & { cleanupError?: Error }) => {
          assert.equal(error, processingError);
          assert.equal(error.cleanupError?.name, 'MediaProcessingCleanupError');
          assert.equal(
            error.cleanupError?.message,
            'Failed to clean up media processing temporary directory: /tmp/media-processing-test',
          );
          assert.equal(error.cleanupError?.cause, cleanupError);
          return true;
        },
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.deepEqual(harness.removedTempDirs, ['/tmp/media-processing-test']);
    assert.deepEqual(loggedErrors, [[
      'Failed to clean up media processing temporary directory',
      (processingError as Error & { cleanupError?: Error }).cleanupError,
    ]]);
  });

  it('surfaces a contextual cleanup failure after successful processing', async () => {
    const cleanupError = new Error('temporary directory is busy');
    const harness = createHarness({ cleanupError });

    await assert.rejects(
      processSubmissionMedia(submission, harness.dependencies),
      (error: Error) => {
        assert.equal(error.name, 'MediaProcessingCleanupError');
        assert.equal(
          error.message,
          'Failed to clean up media processing temporary directory: /tmp/media-processing-test',
        );
        assert.equal(error.cause, cleanupError);
        return true;
      },
    );

    assert.deepEqual(harness.removedTempDirs, ['/tmp/media-processing-test']);
  });
});