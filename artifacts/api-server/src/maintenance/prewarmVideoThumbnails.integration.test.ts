import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { pool, submissionsTable } from '@workspace/db';
import { drizzle } from 'drizzle-orm/node-postgres';

const exec = promisify(execFile);

test('real prewarm selection uses completed-only bounded keysets and never changes submission data',
  { timeout: 60_000 }, async () => {
    const schema = `prewarm_${randomUUID().replaceAll('-', '')}`;
    const client = await pool.connect();
    let dir: string | undefined;
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      // No public fallback: even an accidental write targets only this fixture.
      await client.query(`SET search_path TO "${schema}"`);
      // Copy structure/defaults only, never records or indexes. Every fixture ID
      // is explicit, so the public serial sequence is never advanced.
      await client.query(`CREATE TABLE submissions (LIKE public.submissions INCLUDING DEFAULTS)`);
      const db = drizzle(client);
      const cases = [
        { id: 90, processingStatus: 'completed', status: 'approved', publishedAt: new Date('2025-01-02') },
        { id: 10, processingStatus: 'completed', status: 'pending', publishedAt: null },
        { id: 20, processingStatus: 'queued', status: 'approved', publishedAt: new Date('2025-01-03') },
        { id: 30, processingStatus: 'processing', status: 'pending', publishedAt: null },
        { id: 40, processingStatus: 'failed', status: 'rejected', publishedAt: null },
        { id: 50, processingStatus: 'completed', status: 'approved', publishedAt: new Date(0), path: null },
        { id: 60, processingStatus: 'completed', status: 'pending', publishedAt: null, path: '' },
        { id: 70, processingStatus: 'completed', status: 'needs_edit', publishedAt: null },
        { id: 110, processingStatus: 'completed', status: 'rejected', publishedAt: new Date(0) },
        { id: 130, processingStatus: 'completed', status: 'approved', publishedAt: new Date('2025-01-04') },
      ] as const;
      for (const row of cases) {
        await db.insert(submissionsTable).values({
          id: row.id, processingStatus: row.processingStatus, status: row.status,
          publishedAt: row.publishedAt,
          processedVideoObjectPath: 'path' in row ? row.path : `/objects/fixture-${row.id}`,
          ownerName: `Owner ${row.id}`, email: `fixture-${row.id}@example.invalid`, phone: 'fixture',
          dogName: `Dog ${row.id}`, trickName: `Trick ${row.id}`, trickDescription: 'Synthetic',
          videoObjectPath: `/objects/original-${row.id}`, videoFileName: 'fixture.mp4',
          videoContentType: 'video/mp4', signatureObjectPath: `/objects/signature-${row.id}`,
          category: row.id % 3 === 0 ? 'just_for_fun' : 'contest',
          punchline: `Title ${row.id}`, websiteOrigin: 'synthetic-receipt',
          submittedAt: new Date('2024-01-01'), updatedAt: new Date('2024-02-01'),
        });
      }
      const snapshot = () => db.select().from(submissionsTable).orderBy(submissionsTable.id);
      const before = await snapshot();
      dir = await mkdtemp(join(tmpdir(), 'prewarm-query-'));
      const entry = join(dir, 'cli.mjs');
      const { build } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
      await build({
        entryPoints: [resolve('src/maintenance/prewarmVideoThumbnails.ts')],
        outfile: entry, bundle: true, platform: 'node', format: 'esm',
        banner: { js: `import{createRequire}from'node:module';globalThis.require=createRequire(import.meta.url);` },
        plugins: [{
          name: 'isolated-prewarm-database',
          setup(builder) {
            builder.onResolve({
              filter: /^@workspace\/db$|\/(objectStorage|durableVideoThumbnail)$/,
            }, ({ path }) => ({ path, namespace: 'fixture' }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
              if (path === '@workspace/db') return {
                resolveDir: resolve('../../lib/db'),
                contents: `
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
export { submissionsTable } from './src/schema/submissions';
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c search_path=${schema} -c statement_timeout=5000',
});
export const db = drizzle(pool);
`,
              };
              if (path.endsWith('/objectStorage')) return { contents: `
export class ObjectStorageService {
  async getObjectEntityFile(path) { return { path }; }
}` };
              return { contents: `
export async function durableVideoThumbnail(path, file) {
  if (file.path !== path || !/^\\/objects\\/fixture-\\d+$/.test(path)) {
    throw new Error('Unexpected fixture path');
  }
  console.log(JSON.stringify({ type: 'prepared', id: Number(path.split('-').pop()) }));
}` };
            });
          },
        }],
      });
      const run = async (apply: boolean, afterId: number, throughId: number, limit: number) => {
        const { stdout, stderr } = await exec(process.execPath, [
          entry, apply ? '--apply' : '--dry-run', '--after-id', String(afterId),
          '--through-id', String(throughId), '--limit', String(limit),
        ], { timeout: 10_000 });
        assert.equal(stderr, '');
        const events = stdout.trim().split('\n').map(line => JSON.parse(line));
        return {
          ids: events.filter(e => e.type === 'item').map(e => e.id),
          prepared: events.filter(e => e.type === 'prepared').map(e => e.id),
          summary: events.at(-1),
        };
      };
      const first = await run(false, 0, 110, 2);
      assert.deepEqual(first.ids, [10, 70]);
      assert.deepEqual(first.prepared, []);
      assert.equal(first.summary.hasMore, true, 'limit+1 must detect another eligible row');
      assert.equal(first.summary.resumeAfterId, 70);
      const second = await run(false, first.summary.resumeAfterId, 110, 2);
      assert.deepEqual(second.ids, [90, 110], 'exclusive cursor, inclusive upper bound, ascending across gaps');
      assert.equal(second.summary.hasMore, false, 'rows above the upper bound must not count');
      assert.equal(second.summary.resumeAfterId, 110);
      const empty = await run(false, 110, 110, 2);
      assert.deepEqual(empty.ids, []);
      assert.equal(empty.summary.hasMore, false);
      assert.equal(empty.summary.resumeAfterId, 110);
      assert.deepEqual(await snapshot(), before, 'dry runs must not change any submission field');

      const applied = await run(true, 0, 110, 10);
      assert.deepEqual(applied.ids, [10, 70, 90, 110]);
      assert.deepEqual(applied.prepared, applied.ids, 'only eligible bounded candidates reach media work');
      assert.equal(applied.summary.ready, 4);
      assert.deepEqual(applied.summary.failedIds, []);
      assert.equal(applied.summary.hasMore, false);
      assert.deepEqual(await snapshot(), before,
        'apply preserves all fields, including status, publishedAt, paths, titles and timestamps');
    } finally {
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        client.release(true);
        await pool.end();
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }
  });
