import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { File } from '@google-cloud/storage';
import { durableVideoThumbnail } from './durableVideoThumbnail';
import { ObjectStorageService } from './objectStorage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('durable renderer forwards its exact signal to the default storage downloader', { timeout: 5_000 }, async (t) => {
  const controller = new AbortController();
  const reason = new Error('preview timed out');
  const pinned = { name: 'private/movie' } as File;
  const source = {
    name: pinned.name,
    getMetadata: async () => [{ generation: '42' }],
    bucket: {
      file: (name: string, options: unknown) => {
        assert.equal(name, pinned.name);
        assert.deepEqual(options, { generation: '42' });
        return pinned;
      },
    },
  } as unknown as File;
  let downloads = 0;
  const download = t.mock.method(ObjectStorageService.prototype, 'downloadObject',
    async (file: File, ttl: number | undefined, signal?: AbortSignal) => {
      downloads++;
      assert.strictEqual(file, pinned);
      assert.equal(ttl, undefined);
      assert.strictEqual(signal, controller.signal);
      controller.abort(reason);
      signal!.throwIfAborted();
      assert.fail('aborted download must not return bytes');
    });
  t.after(() => download.mock.restore());
  let saves = 0;
  const result = durableVideoThumbnail('/objects/movie', source, undefined, {
    destination: () => ({
      download: async () => { throw Object.assign(new Error('missing'), { code: 404 }); },
      save: async () => { saves++; },
    }) as unknown as File,
    render: async (_identity, fetchSource) => {
      await fetchSource(controller.signal);
      assert.fail('render must reject when storage is cancelled');
    },
    // Deliberately do not override download: exercise the production adapter.
  });
  await assert.rejects(result, (error) => error === reason);
  assert.equal(downloads, 1);
  assert.equal(saves, 0);
});

test('already-aborted storage download never requests metadata or bytes', async () => {
  const controller = new AbortController();
  const reason = new Error('preview timed out');
  controller.abort(reason);
  const file = {
    getMetadata: () => assert.fail('metadata must not be requested'),
    createReadStream: () => assert.fail('stream must not be opened'),
  } as unknown as File;
  await assert.rejects(
    new ObjectStorageService().downloadObject(file, undefined, controller.signal),
    (error) => error === reason,
  );
});

for (const pendingCall of [1, 2]) {
  test(`abort during ${pendingCall === 1 ? 'content' : 'ACL'} metadata prevents subsequent storage reads`,
    { timeout: 5_000 }, async () => {
      const controller = new AbortController();
      const reason = new Error('preview timed out');
      const entered = deferred<void>();
      const metadata = deferred<[{ contentType: string }]>();
      let metadataCalls = 0;
      let streams = 0;
      const file = {
        getMetadata: async () => {
          if (++metadataCalls === pendingCall) {
            entered.resolve();
            return metadata.promise;
          }
          return [{ contentType: 'video/mp4' }];
        },
        createReadStream: () => {
          streams++;
          return Readable.from(['must not be read']);
        },
      } as unknown as File;
      const download = new ObjectStorageService().downloadObject(file, undefined, controller.signal);
      const rejected = assert.rejects(download, (error) => error === reason);
      await entered.promise;
      controller.abort(reason);
      // Metadata APIs are not cancellable; simulate their late successful reply.
      metadata.resolve([{ contentType: 'video/mp4' }]);
      await rejected;
      assert.equal(metadataCalls, pendingCall, 'no later metadata request may begin');
      assert.equal(streams, 0, 'no byte stream may open after cancellation');
    });
}

test('aborting an active storage read destroys its Node stream and rejects the response reader',
  { timeout: 5_000 }, async (t) => {
    const controller = new AbortController();
    const reason = new Error('preview timed out');
    const stream = new Readable({ read() {} });
    t.after(() => stream.destroy());
    const closed = new Promise<void>((resolve) => stream.once('close', resolve));
    let streamError: Error | undefined;
    stream.once('error', (error) => { streamError = error; });
    let streams = 0;
    const file = {
      getMetadata: async () => [{ contentType: 'video/mp4' }],
      createReadStream: () => { streams++; return stream; },
    } as unknown as File;
    const response = await new ObjectStorageService().downloadObject(file, undefined, controller.signal);
    const reader = response.body!.getReader();
    t.after(() => reader.releaseLock());
    stream.push(Buffer.from('first chunk'));
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(Buffer.from(first.value!).toString(), 'first chunk');
    assert.equal(stream.destroyed, false);
    const pendingRead = reader.read();
    const rejected = assert.rejects(pendingRead, { name: 'AbortError', code: 'ABORT_ERR' });
    controller.abort(reason);
    assert.equal(stream.destroyed, true);
    await Promise.all([closed, rejected]);
    assert.equal(streams, 1);
    assert.equal(streamError?.name, 'AbortError');
    assert.strictEqual(streamError?.cause, reason);
  });
