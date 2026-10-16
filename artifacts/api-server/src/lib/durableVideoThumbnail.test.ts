import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { File } from '@google-cloud/storage';
import { durableVideoThumbnail, thumbnailIdentity } from './durableVideoThumbnail';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function versionedSource() {
  let generation = '1';
  const movies = new Map([['1', 'movie-1'], ['2', 'movie-2']]);
  const pinned = new Map<File, string>();
  const downloaded: string[] = [];
  const source = {
    name: 'private/video',
    getMetadata: async () => [{ generation }],
    bucket: {
      file: (name: string, options: { generation: string }) => {
        assert.equal(name, 'private/video');
        assert.ok(movies.has(options.generation));
        const file = { name } as File;
        pinned.set(file, options.generation);
        return file;
      },
    },
  } as unknown as File;
  return {
    source,
    replace: () => { generation = '2'; },
    downloaded,
    download: async (file: File) => {
      const version = pinned.get(file);
      assert.ok(version, 'downloads must use a generation-pinned handle, not the live source');
      downloaded.push(version);
      return new Response(movies.get(version));
    },
  };
}

const missing = () => Object.assign(new Error('missing'), { code: 404 });

test('independent workers race to create one generation without overwriting the winner', { timeout: 5_000 }, async () => {
  const source = versionedSource();
  const objects = new Map<string, Buffer>();
  const bothMissed = deferred();
  const winnerSaved = deferred();
  let misses = 0;
  let saves = 0;
  let conflicts = 0;
  const rendered = new Map<string, Buffer>();
  const identity = thumbnailIdentity('/objects/movie', '1');
  const worker = (workerId: string) => ({
    destination: (key: string) => {
      assert.equal(key, identity);
      return {
        download: async () => {
          assert.equal(objects.has(key), false);
          if (++misses === 2) bothMissed.resolve();
          await bothMissed.promise;
          throw missing();
        },
        save: async (bytes: Buffer, options: Parameters<File['save']>[1]) => {
          saves++;
          assert.equal(options?.preconditionOpts?.ifGenerationMatch, 0);
          assert.deepEqual(options?.metadata?.metadata, {
            sourceGeneration: '1', sourcePath: '/objects/movie',
          });
          assert.equal(options?.metadata?.cacheControl, 'private, no-store');
          assert.equal(options?.metadata?.contentType, 'image/jpeg');
          assert.equal(options?.resumable, false);
          if (workerId === 'loser') await winnerSaved.promise;
          if (objects.has(key)) {
            conflicts++;
            throw Object.assign(new Error('already created'), { code: 412 });
          }
          objects.set(key, bytes);
          winnerSaved.resolve();
        },
      } as unknown as File;
    },
    // Separate renderers model servers with no shared in-memory render cache.
    render: async (key: string, download: () => Promise<Response>) => {
      assert.equal(key, identity);
      const bytes = Buffer.from(`${workerId}:${await (await download()).text()}`);
      rendered.set(workerId, bytes);
      return bytes;
    },
    download: source.download,
  });
  const [winner, loser] = await Promise.all([
    durableVideoThumbnail('/objects/movie', source.source, undefined, worker('winner')),
    durableVideoThumbnail('/objects/movie', source.source, undefined, worker('loser')),
  ]);
  assert.equal(winner.toString(), 'winner:movie-1');
  assert.equal(loser.toString(), 'loser:movie-1');
  assert.strictEqual(winner, rendered.get('winner'));
  assert.strictEqual(loser, rendered.get('loser'));
  assert.deepEqual(source.downloaded, ['1', '1']);
  assert.equal(misses, 2);
  assert.equal(saves, 2);
  assert.equal(conflicts, 1);
  assert.equal(objects.size, 1);
  assert.deepEqual(objects.get(identity), winner);
  const cold = await durableVideoThumbnail('/objects/movie', source.source, undefined, {
    destination: (key) => ({
      download: async () => [objects.get(key)],
      save: async () => assert.fail('cold read must not save'),
    }) as unknown as File,
    render: async () => { throw new Error('cold read must not render'); },
    download: async () => { throw new Error('cold read must not download source'); },
  });
  assert.deepEqual(cold, winner);
});

for (const code of [403, 404, 429, 500, 503, '412', undefined]) {
  test(`persistence error ${String(code)} propagates unchanged and permits retry`, async () => {
    const source = versionedSource();
    const failure = Object.assign(new Error('save failed'), { code });
    let stored: Buffer | undefined;
    let saves = 0;
    let renders = 0;
    const deps = {
      destination: () => ({
        download: async () => {
          if (!stored) throw missing();
          return [stored];
        },
        save: async (bytes: Buffer, options: Parameters<File['save']>[1]) => {
          assert.equal(options?.preconditionOpts?.ifGenerationMatch, 0);
          assert.equal(options?.resumable, false);
          assert.deepEqual(options?.metadata, {
            contentType: 'image/jpeg',
            cacheControl: 'private, no-store',
            metadata: { sourcePath: '/objects/movie', sourceGeneration: '1' },
          });
          if (++saves === 1) throw failure;
          stored = bytes;
        },
      }) as unknown as File,
      render: async (_key: string, download: () => Promise<Response>) => {
        renders++;
        return Buffer.from(await (await download()).text());
      },
      download: source.download,
    };
    await assert.rejects(
      durableVideoThumbnail('/objects/movie', source.source, undefined, deps),
      (error) => error === failure,
    );
    assert.equal(stored, undefined);
    assert.equal((await durableVideoThumbnail('/objects/movie', source.source, undefined, deps)).toString(), 'movie-1');
    assert.equal((await durableVideoThumbnail('/objects/movie', source.source, undefined, deps)).toString(), 'movie-1');
    assert.equal(saves, 2);
    assert.equal(renders, 2);
    assert.deepEqual(source.downloaded, ['1', '1']);
  });
}

test('source replacement during fallback rendering cannot mix generations', { timeout: 5_000 }, async () => {
  const source = versionedSource();
  const rendering = deferred();
  const replaced = deferred();
  const objects = new Map<string, Buffer>();
  const rendered: string[] = [];
  const deps = {
    destination: (key: string) => ({
      download: async () => {
        if (!objects.has(key)) throw missing();
        return [objects.get(key)];
      },
      save: async (bytes: Buffer, options: Parameters<File['save']>[1]) => {
        const generation = (options?.metadata?.metadata as Record<string, unknown>)?.sourceGeneration;
        assert.equal(key, thumbnailIdentity('/objects/movie', String(generation)));
        assert.equal(bytes.toString(), `movie-${generation}`);
        objects.set(key, bytes);
      },
    }) as unknown as File,
    render: async (key: string, download: () => Promise<Response>) => {
      rendered.push(key);
      rendering.resolve();
      await replaced.promise;
      return Buffer.from(await (await download()).text());
    },
    download: source.download,
  };
  const first = durableVideoThumbnail('/objects/movie', source.source, undefined, deps);
  await rendering.promise;
  source.replace();
  replaced.resolve();
  assert.equal((await first).toString(), 'movie-1');
  assert.equal((await durableVideoThumbnail('/objects/movie', source.source, undefined, deps)).toString(), 'movie-2');
  assert.deepEqual(source.downloaded, ['1', '2']);
  assert.deepEqual(rendered, ['1', '2'].map((generation) => thumbnailIdentity('/objects/movie', generation)));
  assert.equal(objects.size, 2);
});

for (const stage of ['metadata', 'read', 'render', 'download'] as const) {
  test(`412 from ${stage} is not swallowed as a persistence conflict`, async () => {
    const source = versionedSource();
    const failure = Object.assign(new Error(`${stage} failed`), { code: 412 });
    if (stage === 'metadata') source.source.getMetadata = async () => { throw failure; };
    await assert.rejects(durableVideoThumbnail('/objects/movie', source.source, undefined, {
      destination: () => ({
        download: async () => { throw stage === 'read' ? failure : missing(); },
        save: async () => assert.fail('must not persist after failure'),
      }) as unknown as File,
      render: async (_key, download) => {
        if (stage === 'render') throw failure;
        return Buffer.from(await (await download()).text());
      },
      download: async () => { throw failure; },
    }), (error) => error === failure);
  });
}

test('durable previews survive a cold renderer and are isolated by path and generation', async () => {
  const objects = new Map<string, Buffer>();
  let generation = '1';
  let renders = 0;
  let pinnedGeneration: unknown;
  const source = {
    name: 'private/video',
    getMetadata: async () => [{ generation }],
    bucket: { file: (_name: string, options: { generation: string }) => {
      pinnedGeneration = options.generation;
      return source;
    } },
  } as unknown as File;
  const destination = (identity: string) => ({
    download: async () => {
      if (!objects.has(identity)) throw Object.assign(new Error('missing'), { code: 404 });
      return [objects.get(identity)];
    },
    save: async (bytes: Buffer, options: any) => {
      assert.equal(options.metadata.cacheControl, 'private, no-store');
      assert.equal(options.metadata.metadata.sourceGeneration, generation);
      assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
      objects.set(identity, bytes);
    },
  }) as unknown as File;
  const render = async (_key: string, download: () => Promise<Response>) => {
    renders++;
    await download();
    return Buffer.from(`image-${generation}`);
  };
  const deps = { destination, render, download: async () => new Response('movie') };
  assert.equal((await durableVideoThumbnail('/objects/movie', source, undefined, deps)).toString(), 'image-1');
  assert.equal(pinnedGeneration, '1');
  // No in-memory renderer cache participates in this second, cold read.
  assert.equal((await durableVideoThumbnail('/objects/movie', source, undefined, {
    ...deps, render: async () => { throw new Error('must not render'); },
  })).toString(), 'image-1');
  generation = '2';
  assert.equal((await durableVideoThumbnail('/objects/movie', source, undefined, deps)).toString(), 'image-2');
  assert.equal(pinnedGeneration, '2');
  assert.equal(renders, 2);
  assert.notEqual(thumbnailIdentity('/objects/old', '2'), thumbnailIdentity('/objects/new', '2'));
  await durableVideoThumbnail('/objects/new', source, Buffer.from('prepared'), deps);
  assert.equal(renders, 2);
  assert.equal(objects.get(thumbnailIdentity('/objects/new', '2'))?.toString(), 'prepared');
});

test('storage failures are not treated as cache misses', async () => {
  const source = { getMetadata: async () => [{ generation: '1' }] } as unknown as File;
  await assert.rejects(durableVideoThumbnail('/objects/movie', source, undefined, {
    destination: () => ({
      download: async () => { throw Object.assign(new Error('unavailable'), { code: 503 }); },
    }) as unknown as File,
    render: async () => { throw new Error('must not render'); },
  }), /unavailable/);
});
