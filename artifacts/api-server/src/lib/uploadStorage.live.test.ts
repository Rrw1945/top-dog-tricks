import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectStorageService } from './objectStorage';

// Opt-in only: tiny synthetic objects, removed in finally; no database or notification calls.
test('live storage enforces declared byte length and prevents session overwrite', {
  skip: process.env.UPLOAD_STORAGE_SMOKE !== '1',
}, async () => {
  const storage = new ObjectStorageService();
  const paths: string[] = [];
  try {
    for (const length of [4, 5]) {
      const upload = await storage.createEntryUpload({ name: 'fixture.mp4', contentType: 'video/mp4', size: 4 });
      paths.push(upload.objectPath);
      const response = await fetch(upload.uploadURL, {
        method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.alloc(length),
      });
      // Do not log bearer session URLs or response bodies.
      if (length === 4) {
        assert.ok(response.ok, `Exact size upload returned ${response.status}`);
        const file = await storage.getObjectEntityFile(upload.objectPath);
        const [metadata] = await file.getMetadata();
        assert.equal(Number(metadata.size), 4);
        assert.equal(metadata.contentType, 'video/mp4');
        const retry = await fetch(upload.uploadURL, {
          method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('edit'),
        });
        await retry.body?.cancel();
        const [bytes] = await file.download();
        assert.deepEqual(bytes, Buffer.alloc(4), 'Completed sessions must not overwrite an object');
      } else {
        assert.ok(!response.ok, 'Storage must reject excess bytes');
      }
      await response.body?.cancel();
    }
  } finally {
    for (const path of paths) {
      try {
        const file = await storage.getObjectEntityFile(path);
        await file.delete();
      } catch (error) {
        if ((error as Error).name !== 'ObjectNotFoundError' && (error as { code?: number }).code !== 404) throw error;
      }
    }
  }
});
