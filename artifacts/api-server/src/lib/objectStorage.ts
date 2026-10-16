import { randomUUID } from 'crypto';
import { Readable, addAbortSignal } from 'stream';
import { File, Storage } from '@google-cloud/storage';
import { InvalidUploadError, validateMediaContent, validateStoredSize, validateUploadMetadata, type UploadKind } from './uploadValidation';

import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectAclPolicy,
  ObjectPermission,
  setObjectAclPolicy,
} from './objectAcl';

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

export const objectStorageClient = new Storage({
  credentials: {
    audience: 'replit',
    subject_token_type: 'access_token',
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: 'external_account',
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: 'json',
        subject_token_field_name: 'access_token',
      },
    },
    universe_domain: 'googleapis.com',
  },
  projectId: '',
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  async createEntryUpload(input: { name: string; size: number; contentType: string }, origin?: string): Promise<{ uploadURL: string; objectPath: string }> {
    validateUploadMetadata(input);
    const entityId = `uploads/${randomUUID()}`;
    const { bucketName, objectName } = parseObjectPath(`${this.getPrivateObjectDir()}/${entityId}`);
    const [uploadURL] = await objectStorageClient.bucket(bucketName).file(objectName).createResumableUpload({
      // GCS binds browser CORS responses to the origin supplied at session creation.
      // Preserve the caller's origin instead of the API server's internal hostname.
      origin,
      metadata: { contentType: input.contentType, contentLength: input.size,
        cacheControl: 'private, no-store' },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    const objectPath = `/objects/${entityId}`;
    // Persist eligibility before exposing a session. Failure leaves an untracked
    // session, never a returned upload that cleanup can mistake for abandoned.
    const { registerEntryUpload } = await import('./entryUploadRegistry');
    await registerEntryUpload(objectPath);
    return { uploadURL, objectPath };
  }

  async validateEntryUpload(objectPath: string, kind: UploadKind, claimedType?: string): Promise<File> {
    if (!/^\/objects\/uploads\/[a-f0-9-]{36}$/.test(objectPath)) {
      throw new InvalidUploadError('Upload a new file before submitting your entry.');
    }
    const file = await this.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    validateStoredSize(size, kind);
    const contentType = metadata.contentType ?? '';
    if ((kind === 'signature' && contentType !== 'image/png') ||
        (kind === 'video' && !['video/mp4', 'video/quicktime'].includes(contentType)) ||
        (claimedType !== undefined && claimedType !== contentType)) {
      throw new InvalidUploadError('Stored file type does not match the entry.');
    }
    if (!metadata.generation) throw new Error('Storage omitted the object generation');
    // Pin both inspection and copying to the same bytes, even if an old upload URL overwrites the source.
    const pinned = file.bucket.file(file.name, { generation: metadata.generation });
    await validateMediaContent(pinned.createReadStream(), size, kind, contentType);
    return pinned;
  }

  // Caller reserves and locks this destination through insertion/commit.
  async preserveEntryUpload(file: File, destination: string): Promise<string> {
    if (!/^\/objects\/accepted\/[a-f0-9-]{36}$/.test(destination)) {
      throw new Error('Invalid preservation destination');
    }
    const entityId = destination.slice('/objects/'.length);
    const { bucketName, objectName } = parseObjectPath(`${this.getPrivateObjectDir()}/${entityId}`);
    await file.copy(objectStorageClient.bucket(bucketName).file(objectName), {
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return `/objects/${entityId}`;
  }

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || '';
    const paths = Array.from(
      new Set(
        pathsStr
          .split(',')
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          'tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).',
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || '';
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    const privateDir = this.getPrivateObjectDir().replace(/\/+$/, '');
    if (!isCanonicalObjectName(privateDir)) throw new Error('Invalid PRIVATE_OBJECT_DIR');
    const privateRoot = parseObjectPath(privateDir);
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      if (!isCanonicalObjectName(searchPath) || !isCanonicalObjectName(filePath)) continue;
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      if (bucketName === privateRoot.bucketName &&
          (!privateRoot.objectName || objectName === privateRoot.objectName ||
           objectName.startsWith(`${privateRoot.objectName}/`))) continue;
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async getObjectEntityReadURL(objectPath: string): Promise<string> {
    const file = await this.getObjectEntityFile(objectPath);
    return signObjectURL({
      bucketName: file.bucket.name,
      objectName: file.name,
      method: 'GET',
      ttlSec: 900,
    });
  }

  async downloadObject(
    file: File,
    cacheTtlSec: number = 3600,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const [metadata] = await file.getMetadata();
    signal?.throwIfAborted();
    const aclPolicy = await getObjectAclPolicy(file);
    signal?.throwIfAborted();
    const isPublic = aclPolicy?.visibility === 'public';

    const nodeStream = file.createReadStream();
    if (signal) addAbortSignal(signal, nodeStream);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      'Content-Type':
        (metadata.contentType as string) || 'application/octet-stream',
      'Cache-Control': `${isPublic ? 'public' : 'private'}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers['Content-Length'] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: 'PUT',
      ttlSec: 900,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith('/objects/')) {
      throw new ObjectNotFoundError();
    }

    if (!isCanonicalObjectName(objectPath.slice('/objects/'.length))) {
      throw new ObjectNotFoundError();
    }
    const parts = objectPath.slice(1).split('/');
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join('/');
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith('/')) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  async saveObjectEntity(
    contents: Buffer,
    contentType: string,
    extension: string,
  ): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = `${randomUUID()}${extension.startsWith('.') ? extension : `.${extension}`}`;
    const entityId = `automation/${objectId}`;
    const fullPath = `${privateObjectDir}/${entityId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const objectFile = objectStorageClient.bucket(bucketName).file(objectName);

    await objectFile.save(contents, {
      resumable: false,
      metadata: {
        contentType,
        cacheControl: 'private, max-age=3600',
      },
    });

    return `/objects/${entityId}`;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith('https://storage.googleapis.com/')) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith('/')) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith('/')) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const pathParts = path.split('/');
  if (pathParts.length < 3) {
    throw new Error('Invalid path: must contain at least a bucket name');
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join('/');

  return {
    bucketName,
    objectName,
  };
}

function isCanonicalObjectName(path: string): boolean {
  const name = path.replace(/^\//, '');
  return !!name && !/[%\\\u0000-\u001f]/.test(name) &&
    name.split('/').every((part) => !!part && part !== '.' && part !== '..');
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`,
    );
  }

  const body = (await response.json()) as { signed_url?: unknown };
  if (typeof body.signed_url !== 'string') {
    throw new Error('Object storage returned an invalid signed URL');
  }

  return body.signed_url;
}
