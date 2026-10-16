import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

// Bundle the actual entrypoint, substituting only external service boundaries.
// The runner and the CLI's signal handlers, reporting and finally block are real.
describe('thumbnail prewarm CLI interruption', {
  skip: process.platform === 'win32' ? 'Requires catchable POSIX process signals' : false,
}, () => {
  let dir: string;
  let entry: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prewarm-signals-'));
    entry = join(dir, 'cli.mjs');
    const { build } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
    await build({
      entryPoints: [resolve('src/maintenance/prewarmVideoThumbnails.ts')],
      outfile: entry, bundle: true, platform: 'node', format: 'esm',
      plugins: [{
        name: 'isolated-prewarm-services',
        setup(builder) {
          builder.onResolve({
            filter: /^(fixture-control|@workspace\/db|drizzle-orm)$|\/(objectStorage|durableVideoThumbnail)$/,
          }, ({ path }) => ({ path, namespace: 'fixture' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
            if (path === 'fixture-control') return { contents: `
export const mode = process.env.FIXTURE_MODE;
export const privateError = 'PRIVATE_PROVIDER_DETAIL https://private.invalid/video?token=SECRET_TOKEN';
export const send = (event) => process.send(event);
const gates = new Map();
process.on('message', (message) => {
  const release = gates.get(message);
  if (release) { gates.delete(message); release(); }
});
export const wait = (name) => new Promise(resolve => gates.set(name, resolve));
export async function active(stage) {
  const release = wait('release-item');
  // Observe real signal delivery without implementing the CLI's stop behavior.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => send({ type: 'signal-seen', signal }));
  }
  send({ type: 'active', stage });
  await release;
  if (mode !== 'success') throw new Error(privateError);
}
` };
            if (path === '@workspace/db') return { contents: `
import { send, wait } from 'fixture-control';
export const submissionsTable = {};
const rows = [11, 22, 33].map(id => ({
  id, processedVideoObjectPath: '/objects/private-' + id,
}));
const query = {
  from() { return this; }, where() { return this; }, orderBy() { return this; },
  async limit() { send({ type: 'selected', ids: rows.map(row => row.id) }); return rows; },
};
export const db = { select() { return query; } };
export const pool = { async end() {
  const release = wait('release-pool');
  send({ type: 'pool-closing' });
  await release;
  send({ type: 'pool-closed' });
  process.disconnect();
} };
` };
            if (path === 'drizzle-orm') return { contents: `
export const and = () => {};
export const asc = and, eq = and, gt = and, lte = and, isNotNull = and, ne = and;
` };
            if (path.endsWith('/objectStorage')) return { contents: `
import { send, active, mode } from 'fixture-control';
export class ObjectStorageService {
  async getObjectEntityFile(path) {
    send({ type: 'storage', id: Number(path.split('-').pop()) });
    if (path.endsWith('-22') && mode === 'storage-error') await active('storage');
    return { path };
  }
}
` };
            if (path.endsWith('/durableVideoThumbnail')) return { contents: `
import { send, active } from 'fixture-control';
export async function durableVideoThumbnail(path, file) {
  if (file.path !== path) throw new Error('fixture source mismatch');
  send({ type: 'thumbnail', id: Number(path.split('-').pop()) });
  if (path.endsWith('-22')) await active('thumbnail');
}
` };
            throw new Error(`Unexpected fixture import: ${path}`);
          });
        },
      }],
    });
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const mode of ['success', 'storage-error', 'renderer-error']) {
      it(`${signal} drains an active ${mode} item without starting the next`, { timeout: 15_000 }, async () => {
        const child = spawn(process.execPath, [
          entry, '--apply', '--after-id', '7', '--through-id', '40', '--limit', '3',
        ], {
          env: { FIXTURE_MODE: mode },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stdout = '';
        let stderr = '';
        const events: Array<{ type: string; id?: number; signal?: string; stage?: string }> = [];
        child.stdout!.on('data', data => { stdout += data; });
        child.stderr!.on('data', data => { stderr += data; });
        const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        // A watchdog also bounds waits if signal wiring regresses or cleanup hangs.
        const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
        const waitFor = (type: string) => new Promise<void>((resolve, reject) => {
          if (events.some(event => event.type === type)) return resolve();
          const onMessage = (event: { type: string }) => {
            if (event.type === type) { cleanup(); resolve(); }
          };
          const onClose = () => {
            cleanup();
            reject(new Error(`Child closed before ${type}; stdout=${stdout}; stderr=${stderr}`));
          };
          const cleanup = () => {
            child.off('message', onMessage);
            child.off('close', onClose);
          };
          child.on('message', onMessage);
          child.once('close', onClose);
        });
        child.on('message', event => { events.push(event as typeof events[number]); });
        try {
          await waitFor('active');
          assert.equal(events.find(event => event.type === 'active')?.stage,
            mode === 'storage-error' ? 'storage' : 'thumbnail');
          assert.equal(child.kill(signal), true);
          await waitFor('signal-seen');
          assert.equal(events.find(event => event.type === 'signal-seen')?.signal, signal);
          assert.equal(events.some(event => event.type === 'pool-closing'), false,
            'cleanup must wait for active media work');
          child.send('release-item');
          await waitFor('pool-closing');
          assert.equal(child.exitCode, null, 'CLI must await asynchronous pool cleanup');
          child.send('release-pool');
          const result = await closed;
          assert.deepEqual(result, { code: 1, signal: null }, 'exit via CLI, not OS termination');
          assert.equal(events.filter(event => event.type === 'pool-closed').length, 1);
          assert.equal(events.filter(event => event.type === 'pool-closing').length, 1);
          assert.deepEqual(events.filter(event => event.type === 'storage').map(event => event.id), [11, 22]);
          assert.deepEqual(events.filter(event => event.type === 'thumbnail').map(event => event.id),
            mode === 'storage-error' ? [11] : [11, 22]);
          const failed = mode !== 'success';
          const output = stdout.trim().split('\n').map(line => JSON.parse(line));
          assert.deepEqual(output, [
            { type: 'item', id: 11, status: 'ready', resumeAfterId: 11 },
            { type: 'item', id: 22, status: failed ? 'failed' : 'ready', resumeAfterId: failed ? 11 : 22 },
            {
              type: 'summary', mode: 'apply', attempted: 2, ready: failed ? 1 : 2,
              failedIds: failed ? [22] : [], resumeAfterId: failed ? 11 : 22,
              scannedThroughId: 22, throughId: 40, hasMore: true, interrupted: true,
            },
          ]);
          assert.equal(stderr, '');
          assert.doesNotMatch(stdout + stderr, /PRIVATE_PROVIDER_DETAIL|private\.invalid|SECRET_TOKEN|\/objects\//);
        } finally {
          clearTimeout(watchdog);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await closed;
        }
      });
    }
  }
});
