import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildVoiceoverScript, findTrimWindow, processSubmissionMedia, run } from './mediaProcessing';
import {
  buildHookLine,
  buildVideoTitleFilter,
  wrapHookText,
} from './videoTitleStyle';

const submission = {
  videoObjectPath: '/videos/dog.mp4',
  dogName: 'Scout',
  trickName: 'Spin',
  trickDescription: 'Scout spins in a circle',
  punchline: 'A perfect pirouette on two paws.',
  trimStartSeconds: null,
  trimEndSeconds: null,
} as Parameters<typeof processSubmissionMedia>[0];

describe('voiceover wording', () => {
  it('uses the owner description without also reading the title', () => {
    assert.equal(buildVoiceoverScript(submission), 'This is Scout. Scout spins in a circle');
    assert.equal(buildVoiceoverScript({
      dogName: 'Luna',
      trickName: 'Airtime Frisbee Catch',
      trickDescription: 'She jumps high to catch her favorite frisbee.',
    }), 'This is Luna. She jumps high to catch her favorite frisbee.');
  });

  it('reads matching title and description only once', () => {
    assert.equal(buildVoiceoverScript({
      dogName: 'Scout', trickName: 'Spins in a circle.', trickDescription: 'Spins in a circle.',
    }), 'This is Scout. Spins in a circle.');
  });

  it('uses the title for legacy entries without a description', () => {
    assert.equal(buildVoiceoverScript({
      dogName: ' Scout! ', trickName: ' Spin ', trickDescription: ' ',
    }), 'This is Scout. Spin');
  });

  it('keeps the existing narration word limit', () => {
    const script = buildVoiceoverScript({
      ...submission, trickDescription: 'word '.repeat(40),
    });
    assert.equal(script.split(/\s+/).length, 24);
    assert.ok(script.endsWith('…'));
  });
});

function createHarness(options: {
  processingError?: Error;
  cleanupError?: Error;
  sourceHasAudio?: boolean;
  normalizedHasAudio?: boolean;
} = {}) {
  const removedTempDirs: string[] = [];
  const commands: { command: string; args: string[] }[] = [];
  const dependencies = {
    persistThumbnail: async () => {},
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
    run: async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command === 'ffprobe') {
        if (args.includes('stream=duration')) {
          return { stdout: '10.033333\n', stderr: '' };
        }
        const hasAudio = args.at(-1)?.endsWith('normalized.mp4')
          ? options.normalizedHasAudio
          : options.sourceHasAudio;
        return { stdout: hasAudio ? '1\n' : '', stderr: '' };
      }
      return { stdout: '', stderr: 'Duration: 00:00:10.00' };
    },
    textToSpeech: async () => Buffer.from('voice'),
    saveObject: async (_data: Buffer, contentType: string) =>
      contentType === 'video/mp4' ? '/processed/video.mp4' : '/voiceovers/voice.mp3',
  };
  return { dependencies, removedTempDirs, commands };
}

describe('video audio stream selection', () => {
  it('persists the finished video thumbnail before reporting success and fails if persistence fails', async () => {
    const harness = createHarness();
    const persisted: string[] = [];
    await processSubmissionMedia(submission, {
      ...harness.dependencies,
      persistThumbnail: async (path, bytes) => {
        persisted.push(path);
        assert.ok(bytes.length > 0);
      },
    });
    assert.deepEqual(persisted, ['/processed/video.mp4']);
    assert.ok(harness.commands.some(({ args }) =>
      args.includes('/tmp/media-processing-test/finished.mp4') &&
      args.includes('thumbnail=15,scale=480:-2')));
    await assert.rejects(processSubmissionMedia(submission, {
      ...harness.dependencies,
      persistThumbnail: async () => { throw new Error('thumbnail save failed'); },
    }), /thumbnail save failed/);
  });
  it('requests the younger, enthusiastic narration style', async () => {
    const harness = createHarness();
    let voiceRequest: unknown[] = [];
    await processSubmissionMedia(submission, {
      ...harness.dependencies,
      textToSpeech: async (...args) => {
        voiceRequest = args;
        return Buffer.from('voice');
      },
    });
    assert.equal(voiceRequest[1], 'echo');
    assert.match(String(voiceRequest[3]), /younger-sounding adult male/);
    assert.match(String(voiceRequest[3]), /friendly enthusiasm/);
  });
  for (const [name, sourceHasAudio, normalizedHasAudio] of [
    ['replaces surviving source audio', true, true],
    ['uses voiceover when trimming leaves no audio stream', true, false],
    ['supports silent source video', false, false],
  ] as const) {
    it(name, async () => {
      const harness = createHarness({ sourceHasAudio, normalizedHasAudio });
      await processSubmissionMedia(submission, harness.dependencies);
      const finalCommand = harness.commands.find(({ args }) => args.includes('-filter_complex'));
      assert.ok(finalCommand);
      const filter = finalCommand.args[finalCommand.args.indexOf('-filter_complex') + 1]!;
      assert.equal(filter.includes('[0:a]'), false);
      assert.equal(filter.includes('apad'), true);
      assert.match(filter, /apad,atrim=duration=10\.033333\[voice\]/);
      assert.match(filter, /\[2:a\]volume=0.16/);
      assert.ok(!finalCommand.args.includes('-shortest'));
      assert.ok(harness.commands.some(({ command, args }) =>
        command === 'ffprobe' && args.at(-1)?.endsWith('normalized.mp4')));
    });
  }
  it('can omit the music without bringing back original audio', async () => {
    const harness = createHarness();
    await processSubmissionMedia({ ...submission, soundtrack: 'voiceover_only' }, harness.dependencies);
    const command = harness.commands.find(({ args }) => args.includes('-filter_complex'))!;
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    assert.ok(!filter.includes('[0:a]'));
    assert.ok(!filter.includes('[2:a]'));
    assert.ok(!command.args.includes('-stream_loop'));
    assert.match(filter, /apad,atrim=duration=10\.033333\[aout\]/);
  });
});

describe('media subprocess diagnostics', () => {
  it('reports the terminating signal rather than a null exit code', async () => {
    await assert.rejects(
      run(process.execPath, ['-e', 'process.stderr.write("encoder stopped\\n"); process.kill(process.pid, "SIGTERM")']),
      /terminated by signal SIGTERM: encoder stopped/,
    );
  });

  it('retains only the tail of long ffmpeg diagnostics', async () => {
    await assert.rejects(
      run(process.execPath, ['-e', 'process.stderr.write("x".repeat(100000) + "final diagnostic"); process.exit(1)']),
      (error: Error) => {
        assert.match(error.message, /exited with code 1: .*final diagnostic$/);
        assert.ok(error.message.length < 4100);
        return true;
      },
    );
  });
});

describe('normalized video duration validation', () => {
  it('does not encode or save media if the normalized video has no measurable duration', async () => {
    const harness = createHarness();
    await assert.rejects(
      processSubmissionMedia(submission, {
        ...harness.dependencies,
        run: async (command, args) => {
          if (command === 'ffprobe' && args.includes('stream=duration')) {
            return { stdout: 'N/A\n', stderr: '' };
          }
          return harness.dependencies.run(command, args);
        },
      }),
      /Normalized video has no valid video duration: N\/A/,
    );
    assert.equal(harness.commands.filter(({ command }) => command === 'ffmpeg').length, 2);
    assert.deepEqual(harness.removedTempDirs, ['/tmp/media-processing-test']);
  });
});

describe('silent video trimming', () => {
  it('keeps footage when the entire soundtrack is silent', async () => {
    const result = await findTrimWindow('input', async () => ({
      stdout: '',
      stderr: 'Duration: 00:00:10.00\nsilence_start: 0\nsilence_end: 10',
    }));
    assert.deepEqual(result, { start: 0 });
  });

  it('keeps footage when detected silence leaves less than a second', async () => {
    const result = await findTrimWindow('input', async () => ({
      stdout: '',
      stderr: 'Duration: 00:00:10.00\nsilence_start: 0\nsilence_end: 9.8',
    }));
    assert.deepEqual(result, { start: 0 });
  });

  it('still trims ordinary leading and trailing silence', async () => {
    const result = await findTrimWindow('input', async () => ({
      stdout: '',
      stderr: 'Duration: 00:00:10.00\nsilence_start: 0\nsilence_end: 2\nsilence_start: 8\nsilence_end: 10',
    }));
    assert.deepEqual(result, { start: 2, end: 8 });
  });
});

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

describe('video title styling', () => {
  it('uses the dog name followed by the saved punchline only', () => {
    assert.equal(
      buildHookLine({
        dogName: ' Scout ',
        punchline: ' A perfect pirouette on two paws. ',
      }),
      'Scout\nA perfect pirouette on two paws.',
    );
    assert.equal(buildHookLine({ dogName: 'Blue', punchline: null }), 'Blue');
    assert.equal(buildHookLine({ dogName: 'Blue', punchline: '   ' }), 'Blue');
  });

  it('preserves the complete saved punchline without truncating its words', () => {
    const punchline = 'This saved punchline is intentionally long. '.repeat(4).trim();
    const longHook = buildHookLine({
      dogName: 'Scout',
      punchline,
    });
    assert.equal(longHook, `Scout\n${punchline}`);
  });

  it('writes the saved overlay for the future processor before requesting speech', async () => {
    const harness = createHarness();
    let writtenHook: string | Uint8Array | undefined;
    await processSubmissionMedia(submission, {
      ...harness.dependencies,
      writeFile: async (path, data) => {
        if (path.endsWith('hook.txt')) writtenHook = data;
      },
      textToSpeech: async () => {
        assert.equal(
          writtenHook,
          wrapHookText(buildHookLine(submission), Number(process.env.VIDEO_TARGET_WIDTH ?? 1080)),
        );
        return Buffer.from('voice');
      },
    });
  });

  it('wraps long titles without changing their words and splits overlong tokens safely', () => {
    const hook =
      'Scout • Championship obstacle course\nSupercalifragilisticexpialidocious clears every tunnel';
    const wrapped = wrapHookText(hook, 360, 36);

    assert.ok(wrapped.split('\n').length > 2);
    assert.equal(
      wrapped.replace(/\s/g, ''),
      hook.replace(/\s/g, ''),
    );
  });

  it('keeps new and refreshed videos free of burned-in text', () => {
    const filter = buildVideoTitleFilter({
      hookTextPath: "/tmp/title's:hook.txt",
      targetWidth: 1080,
      targetHeight: 1920,
    });

    assert.equal(filter, 'null');
    assert.doesNotMatch(filter, /drawtext|drawbox|textfile/);
  });
});