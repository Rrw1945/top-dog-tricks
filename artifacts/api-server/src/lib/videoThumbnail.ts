import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cache = new Map<string, { bytes: Buffer; expires: number }>();
const pending = new Map<string, Promise<Buffer>>();
let queue = Promise.resolve();

// Race even non-cooperative callbacks, and dispose of any response arriving
// after cancellation so it cannot retain a storage connection.
async function downloadWithinDeadline(
  download: (signal?: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const response = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return download(signal);
  }).then((value) => {
    if (signal.aborted) {
      void value.body?.cancel().catch(() => {});
      throw signal.reason;
    }
    return value;
  });
  try {
    return await Promise.race([response, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Call only AFTER the existing object access check, including for cached images. */
export function videoThumbnail(key: string, download: (signal?: AbortSignal) => Promise<Response>): Promise<Buffer> {
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.bytes);
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= 16) return Promise.reject(new Error('Thumbnail queue is full'));
  const job = queue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dog-preview-'));
    try {
      const signal = AbortSignal.timeout(60000);
      const response = await downloadWithinDeadline(download, signal);
      if (!response.ok || !response.body) throw new Error('Video download failed');
      let size = 0;
      const limit = new Transform({
        transform(chunk, _encoding, next) {
          size += chunk.length;
          next(size > 500 * 1024 * 1024 ? new Error('Video too large') : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as never), limit,
        createWriteStream(join(dir, 'video')), { signal });
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1',
        '-i', join(dir, 'video'), '-vf', 'thumbnail=15,scale=480:-2', '-frames:v', '1',
        '-threads', '1', '-y', join(dir, 'preview.jpg')], { timeout: 30000 });
      const bytes = await readFile(join(dir, 'preview.jpg'));
      cache.delete(key);
      cache.set(key, { bytes, expires: Date.now() + 10 * 60 * 1000 });
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
      return bytes;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  pending.set(key, job);
  queue = job.then(() => undefined, () => undefined);
  void job.finally(() => pending.delete(key)).catch(() => {});
  return job;
}
