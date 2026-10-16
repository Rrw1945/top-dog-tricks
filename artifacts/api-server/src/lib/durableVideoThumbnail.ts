import { createHash } from 'node:crypto';
import type { File } from '@google-cloud/storage';
import { ObjectStorageService, objectStorageClient } from './objectStorage';
import { videoThumbnail } from './videoThumbnail';

const storage = new ObjectStorageService();

/** Version the rendering recipe as well as the source's exact storage generation. */
export function thumbnailIdentity(sourcePath: string, generation: string): string {
  return createHash('sha256').update(JSON.stringify(['dog-preview-v1', sourcePath, generation])).digest('hex');
}

function derivedFile(identity: string): File {
  const root = storage.getPrivateObjectDir().replace(/^\/|\/$/g, '');
  const [bucket, ...parts] = root.split('/');
  return objectStorageClient.bucket(bucket).file(`${parts.join('/')}/derived-thumbnails/${identity}.jpg`);
}

type Dependencies = {
  destination: (identity: string) => File;
  render: typeof videoThumbnail;
  download: (source: File, signal?: AbortSignal) => Promise<Response>;
};

/**
 * Internal only: callers must authorize the SOURCE on every request before calling.
 * The derived path is never returned to a browser or made a public asset.
 * preparedBytes lets production reuse the local finished movie instead of downloading it.
 */
export async function durableVideoThumbnail(
  sourcePath: string,
  source: File,
  preparedBytes?: Buffer,
  overrides: Partial<Dependencies> = {},
): Promise<Buffer> {
  const deps: Dependencies = {
    destination: derivedFile,
    render: videoThumbnail,
    download: (file, signal) => storage.downloadObject(file, undefined, signal),
    ...overrides,
  };
  const [metadata] = await source.getMetadata();
  if (!metadata.generation) throw new Error('Storage omitted the video generation');
  const generation = String(metadata.generation);
  const identity = thumbnailIdentity(sourcePath, generation);
  const destination = deps.destination(identity);
  try {
    const [bytes] = await destination.download();
    return bytes;
  } catch (error) {
    if ((error as { code?: number }).code !== 404) throw error;
  }
  const pinnedSource = source.bucket.file(source.name, { generation });
  const bytes = preparedBytes ?? await deps.render(identity, (signal) => deps.download(pinnedSource, signal));
  try {
    await destination.save(bytes, {
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: 'image/jpeg',
        cacheControl: 'private, no-store',
        metadata: { sourcePath, sourceGeneration: generation },
      },
    });
  } catch (error) {
    // Another server may have created the same generation's thumbnail.
    if ((error as { code?: number }).code !== 412) throw error;
  }
  return bytes;
}

export async function persistVideoThumbnail(sourcePath: string, bytes: Buffer): Promise<void> {
  await durableVideoThumbnail(sourcePath, await storage.getObjectEntityFile(sourcePath), bytes);
}
