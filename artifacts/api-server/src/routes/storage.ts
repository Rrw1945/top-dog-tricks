import { Readable } from 'stream';
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';
import { and, eq, or } from 'drizzle-orm';
import { db, submissionsTable } from '@workspace/db';
import { isAdminAuthenticated } from '../lib/adminSession';
import { durableVideoThumbnail } from '../lib/durableVideoThumbnail';
import { InvalidUploadError } from '../lib/uploadValidation';

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Reject noncanonical URLs before Express decodes wildcard parameters. In particular,
// decoding an encoded slash or dot must never change which storage namespace is read.
export function canonicalStoragePath(req: Request, prefix: string): string | null {
  const pathname = req.originalUrl.split('?')[0] ?? '';
  const storageIndex = pathname.indexOf('/storage/');
  if (storageIndex < 0 || !pathname.slice(storageIndex).startsWith(`/storage/${prefix}/`)) return null;
  const marker = `/storage/${prefix}/`;
  const path = pathname.slice(storageIndex + marker.length);
  if (!path || /[%\\\u0000-\u001f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return path;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
}

async function serveFile(req: Request, res: Response, file: Parameters<ObjectStorageService['downloadObject']>[0]): Promise<void> {
  const response = await objectStorageService.downloadObject(file);
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'cache-control') res.setHeader(key, value);
  });
  noStore(res);
  if (req.method === 'HEAD') {
    await response.body?.cancel();
    res.end();
  } else if (response.body) {
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
  } else {
    res.end();
  }
}

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * This endpoint is intentionally public because contest entries are public.
 * The returned object path is opaque and only the submission record exposes it
 * to the admin review flow.
 */
router.post(
  '/storage/uploads/request-url',
  async (req: Request, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;

      const { uploadURL, objectPath } = await objectStorageService.createEntryUpload(
        { name, size, contentType },
        req.get('origin'),
      );

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
        }),
      );
    } catch (error) {
      if (error instanceof InvalidUploadError) {
        res.status(400).json({ error: error.message });
        return;
      }
      req.log.error({ err: error }, 'Error generating upload URL');
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    noStore(res);
    try {
      const filePath = canonicalStoragePath(req, 'public-objects');
      if (!filePath) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      await serveFile(req, res, file);
    } catch (error) {
      req.log.error({ err: error }, 'Error serving public object');
      res.status(500).json({ error: 'Failed to serve public object' });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get('/storage/objects/*path', async (req: Request, res: Response) => {
  noStore(res);
  try {
    const wildcardPath = canonicalStoragePath(req, 'objects');
    if (!wildcardPath) {
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    const normalizedPath = wildcardPath.startsWith('objects/')
      ? wildcardPath.slice('objects/'.length) : wildcardPath;
    const objectPath = `/objects/${normalizedPath}`;
    if (!isAdminAuthenticated(req)) {
      // A path used as an original, signature, or voiceover is never public,
      // even when a processed-video column also refers to it.
      const [privateReference] = await db.select({ id: submissionsTable.id })
        .from(submissionsTable)
        .where(or(eq(submissionsTable.videoObjectPath, objectPath),
          eq(submissionsTable.signatureObjectPath, objectPath),
          eq(submissionsTable.voiceoverObjectPath, objectPath))).limit(1);
      const [published] = privateReference ? [] : await db.select({ id: submissionsTable.id })
        .from(submissionsTable)
        .where(and(eq(submissionsTable.status, 'approved'),
          eq(submissionsTable.processingStatus, 'completed'),
          eq(submissionsTable.processedVideoObjectPath, objectPath))).limit(1);
      if (!published) {
        res.status(401).json({ error: 'Admin authentication required' });
        return;
      }
    }
    const objectFile =
      await objectStorageService.getObjectEntityFile(objectPath);
    if (req.query.preview === '1') {
      const bytes = await durableVideoThumbnail(objectPath, objectFile);
      res.type('image/jpeg').send(bytes);
      return;
    }
    await serveFile(req, res, objectFile);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, 'Object not found');
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    req.log.error({ err: error }, 'Error serving object');
    res.status(500).json({ error: 'Failed to serve object' });
  }
});

export default router;
