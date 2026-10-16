import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
export type UploadKind = 'video' | 'signature';

export class InvalidUploadError extends Error {}
let activeInspections = 0;

export function validateUploadMetadata(input: { name: string; size: number; contentType: string }): UploadKind {
  const kind = input.contentType === 'image/png' ? 'signature' : 'video';
  const extension = input.contentType === 'video/mp4' ? /\.mp4$/i
    : input.contentType === 'video/quicktime' ? /\.mov$/i
    : input.contentType === 'image/png' ? /\.png$/i : null;
  if (!extension || !extension.test(input.name)) {
    throw new InvalidUploadError('Use an MP4 or MOV video and a PNG signature.');
  }
  validateStoredSize(input.size, kind);
  return kind;
}

export function validateStoredSize(size: number, kind: UploadKind): void {
  const max = kind === 'video' ? VIDEO_MAX_BYTES : SIGNATURE_MAX_BYTES;
  if (!Number.isSafeInteger(size) || size < 1 || size > max) {
    throw new InvalidUploadError(kind === 'video'
      ? 'Video must be between 1 byte and 500 MB (524288000 bytes).'
      : 'Signature must be between 1 byte and 2 MB (2097152 bytes).');
  }
}

/** Bounded local inspection; never let media parsers fetch external references. */
export async function validateMediaContent(stream: Readable, size: number, kind: UploadKind, contentType: string): Promise<void> {
  if (activeInspections >= 2) {
    stream.destroy();
    throw new Error('Upload inspection capacity reached; retry shortly');
  }
  activeInspections++;
  try {
    await inspectMediaContent(stream, size, kind, contentType);
  } finally {
    activeInspections--;
    stream.destroy();
  }
}

async function inspectMediaContent(stream: Readable, size: number, kind: UploadKind, contentType: string): Promise<void> {
  validateStoredSize(size, kind);
  const dir = await mkdtemp(join(tmpdir(), 'entry-upload-'));
  const path = join(dir, 'media');
  try {
    let received = 0;
    await pipeline(stream, new Transform({
      transform(chunk, _encoding, next) {
        received += chunk.length;
        next(received > size ? new InvalidUploadError('Stored file size does not match its metadata.') : null, chunk);
      },
    }), createWriteStream(path), { signal: AbortSignal.timeout(120_000) });
    if (received !== size) throw new InvalidUploadError('Stored file is incomplete.');
    const handle = await open(path, 'r');
    const header = Buffer.alloc(32);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    if (kind === 'signature') {
      if (contentType !== 'image/png' || !header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        throw new InvalidUploadError('Signature must contain a PNG image.');
      }
      // Limit decompression work before invoking a decoder.
      const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 4_000_000) {
        throw new InvalidUploadError('Signature image dimensions are too large.');
      }
    } else {
      const atom = header.toString('ascii', 4, 8);
      const brand = header.toString('ascii', 8, 12);
      const mp4Brands = /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/;
      const valid = contentType === 'video/mp4'
        ? atom === 'ftyp' && mp4Brands.test(brand)
        : contentType === 'video/quicktime' && ((atom === 'ftyp' && brand === 'qt  ') ||
          ['moov', 'mdat', 'wide', 'free'].includes(atom));
      if (!valid) throw new InvalidUploadError('Video content must match its MP4 or MOV type.');
    }
    try {
      const { stdout } = await exec('ffprobe', [
        '-v', 'error', '-protocol_whitelist', 'file', '-f', kind === 'video' ? 'mov' : 'png_pipe', '-show_entries',
        'format=format_name:stream=codec_type,codec_name,width,height', '-of', 'json', path,
      ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      const probe = JSON.parse(stdout) as { format?: { format_name?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> };
      if (!probe.streams?.some(s => s.codec_type === 'video' && s.codec_name && s.width && s.height) ||
          (kind === 'video' && !probe.format?.format_name?.split(',').includes('mov')) ||
          (kind === 'signature' && probe.streams.some(s => s.codec_name !== 'png'))) {
        throw new Error('Invalid media structure');
      }
      if (kind === 'signature') {
        await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-f', 'png_pipe',
          '-threads', '1', '-i', path, '-frames:v', '1', '-f', 'null', '-'],
        { timeout: 10_000, maxBuffer: 64 * 1024 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new InvalidUploadError('The uploaded media is damaged or unsupported.');
    }
  } finally {
    stream.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
