// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoredObject } from '@workspace/api-client-react';
import {
  CreateSubmissionBody,
  CreateSubscriberBody,
  RequestUploadUrlBody,
} from '../../../../lib/api-zod/src/generated/api';
import { storedObjectRouteSuffix } from './utils';

afterEach(() => vi.unstubAllGlobals());

describe('older hosted frontend API contracts', () => {
  it('accepts the original entry and newsletter payloads without newly optional fields', () => {
    expect(CreateSubmissionBody.safeParse({
      ownerName: 'Fixture owner',
      email: 'fixture@example.com',
      dogName: 'Fixture dog',
      trickDescription: 'A fixture spin',
      videoObjectPath: '/objects/uploads/video',
      videoFileName: 'video.mp4',
      videoContentType: 'video/mp4',
      signatureObjectPath: '/objects/uploads/signature',
    }).success).toBe(true);
    expect(CreateSubscriberBody.safeParse({ email: 'fixture@example.com', consent: true }).success).toBe(true);
  });

  it('accepts both legacy video formats and PNG signatures, but rejects unsupported MIME types', () => {
    for (const contentType of ['video/mp4', 'video/quicktime', 'image/png']) {
      expect(RequestUploadUrlBody.safeParse({
        name: 'fixture', size: 128, contentType,
      }).success).toBe(true);
    }
    expect(RequestUploadUrlBody.safeParse({
      name: 'fixture', size: 128, contentType: 'video/webm',
    }).success).toBe(false);
  });

  it('serves binary media to legacy Blob consumers through a canonical URL without network calls', async () => {
    const fetchMock = vi.fn(async () => new Response('fixture video', {
      headers: { 'Content-Type': 'video/mp4' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const blob = await getStoredObject(storedObjectRouteSuffix('/objects/automation/video.mp4'));
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe('fixture video');
    expect(fetchMock).toHaveBeenCalledWith('/api/storage/objects/automation/video.mp4',
      expect.objectContaining({ method: 'GET' }));
  });

  it('preserves authorization errors instead of presenting them as playable media', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: 'Admin authentication required' }, { status: 401 },
    )));
    await expect(getStoredObject(storedObjectRouteSuffix('/objects/uploads/signature')))
      .rejects.toMatchObject({ status: 401 });
  });
});
