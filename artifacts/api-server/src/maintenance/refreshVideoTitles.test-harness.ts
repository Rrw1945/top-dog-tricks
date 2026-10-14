import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Bundle the real CLI with strict local substitutes. Neither the DB module nor
// object-storage module (and their credentials/clients) is loaded by this harness.
export async function loadMaintenanceHarness(dir: string) {
  const { build } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
  const outfile = join(dir, 'maintenance-under-test.mjs');
  await build({
    stdin: {
      contents: `export { main } from './src/maintenance/refreshVideoTitles';
export { state } from 'fixture-state';`,
      resolveDir: resolve('.'),
    },
    outfile, bundle: true, platform: 'node', format: 'esm',
    plugins: [{
      name: 'local-maintenance-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /^node:fs\/promises$/ }, ({ importer }) =>
          importer.endsWith('/maintenance/refreshVideoTitles.ts')
            ? { path: 'manifest-filesystem', namespace: 'fixture' } : undefined);
        builder.onResolve({
          filter: /^(fixture-state|@workspace\/db|drizzle-orm)$|\/(objectStorage|mediaProcessing|durableVideoThumbnail)$/,
        }, ({ path }) => ({ path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
          if (path === 'fixture-state') return { contents: `
export const state = {
  rows: [], objects: new Map(), sources: new Map(),
  updates: [], commits: [], saves: [], downloads: [],
  crash: '', race: false,
  manifestFailure: null, manifestFaults: [], thumbnails: [],
};
` };
          if (path === 'manifest-filesystem') return { contents: `
export * from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { state } from 'fixture-state';
let checkpoint;
let manifestPath;
function shouldFail(boundary) {
  return state.manifestFailure?.boundary === boundary &&
    state.manifestFailure?.checkpoint === checkpoint;
}
async function fail(boundary) {
  state.manifestFaults.push({
    boundary, checkpoint, previous: await fs.readFile(manifestPath, 'utf8'),
  });
  state.manifestFailure = null;
  throw new Error('injected manifest ' + boundary + ' failure at ' + checkpoint);
}
export async function open(path, flags, mode) {
  const handle = await fs.open(path, flags, mode);
  if (flags === 'w' && path.endsWith('.tmp')) {
    manifestPath = path.slice(0, -('.' + process.pid + '.tmp').length);
    return {
      async writeFile(data) {
        checkpoint = JSON.parse(data).entries[0].state;
        if (shouldFail('write')) {
          // Model a short write: the temp file really is damaged, not the target.
          await handle.writeFile(data.slice(0, Math.floor(data.length / 2)));
          await fail('write');
        }
        return handle.writeFile(data);
      },
      async sync() {
        if (shouldFail('sync')) await fail('sync');
        return handle.sync();
      },
      close: () => handle.close(),
    };
  }
  if (flags === 'r' && path === dirname(manifestPath)) return {
    async sync() {
      if (shouldFail('directory-sync')) await fail('directory-sync');
      return handle.sync();
    },
    close: () => handle.close(),
  };
  return handle;
}
export async function rename(from, to) {
  if (to === manifestPath && shouldFail('rename')) await fail('rename');
  return fs.rename(from, to);
}
` };
          if (path.endsWith('/durableVideoThumbnail')) return { contents: `
import { state } from 'fixture-state';
export async function durableVideoThumbnail(path) {
  if (!state.objects.has(path)) throw new Error('Thumbnail source was not uploaded');
  state.thumbnails.push(path);
  return Buffer.from('isolated thumbnail');
}
` };
          if (path === 'drizzle-orm') return { contents: `
export const eq = (key, value) => row =>
  row[key] instanceof Date ? row[key].getTime() === value.getTime() : row[key] === value;
export const inArray = (key, values) => row => values.includes(row[key]);
export const and = (...predicates) => row => predicates.every(fn => fn(row));
` };
          if (path === '@workspace/db') return { contents: `
import { state } from 'fixture-state';
export const submissionsTable = new Proxy({}, { get: (_, key) => key });
export const pool = { end() { throw new Error('Unexpected pool access'); } };
export const db = {
  select: () => ({ from: () => ({ where: predicate => {
    const rows = state.rows.filter(predicate).map(row => ({ ...row }));
    return Object.assign(Promise.resolve(rows), { limit: async n => rows.slice(0, n) });
  } }) }),
  update: () => ({ set: values => ({ where: predicate => ({ returning: async () => {
    state.updates.push(values);
    if (state.crash === 'before-update') { state.crash = ''; throw new Error('interrupted before update'); }
    const rows = state.rows.filter(predicate);
    for (const row of rows) { Object.assign(row, values); state.commits.push(row.id); }
    if (state.crash === 'after-update') { state.crash = ''; throw new Error('interrupted after update'); }
    return rows.map(row => ({ id: row.id }));
  } }) }) }),
};
` };
          if (path.endsWith('/mediaProcessing')) return {
            contents: `export const findTrimWindow = async () => ({ start: 0 });`,
          };
          return { contents: `
import { copyFile } from 'node:fs/promises';
import { state } from 'fixture-state';
export class ObjectStorageService {
  getPrivateObjectDir() { return '/fixture/private'; }
  async getObjectEntityFile(path) {
    if (!state.sources.has(path)) throw new Error('Unexpected source: ' + path);
    return { download: async ({ destination }) => copyFile(state.sources.get(path), destination) };
  }
}
export const objectStorageClient = { bucket: name => {
  if (name !== 'fixture') throw new Error('Unexpected bucket');
  return { file: key => {
    const path = '/objects/' + key.replace(/^private\\//, '');
    return {
      exists: async () => [state.objects.has(path)],
      download: async () => { state.downloads.push(path); return [state.objects.get(path)]; },
      save: async (bytes, options) => {
        state.saves.push({ path, options });
        if (state.race) { state.race = false; state.objects.set(path, Buffer.from('racing writer')); }
        if (options.preconditionOpts?.ifGenerationMatch !== 0) throw new Error('Missing create-only precondition');
        if (state.objects.has(path)) throw new Error('412 generation precondition failed');
        state.objects.set(path, Buffer.from(bytes));
        if (state.crash === 'after-save') { state.crash = ''; throw new Error('interrupted after save'); }
      },
    };
  } };
} };
` };
        });
      },
    }],
  });
  return await import(pathToFileURL(outfile).href) as {
    main: (args: string[]) => Promise<void>;
    state: {
      rows: Array<Record<string, unknown>>;
      sources: Map<string, string>;
      objects: Map<string, Buffer>;
      updates: Array<Record<string, unknown>>;
      commits: number[];
      saves: Array<{ path: string; options: { preconditionOpts: { ifGenerationMatch: number } } }>;
      downloads: string[];
      crash: string;
      race: boolean;
      manifestFailure: {
        boundary: 'write' | 'sync' | 'rename' | 'directory-sync';
        checkpoint: 'uploaded' | 'applied';
      } | null;
      manifestFaults: Array<{ boundary: string; checkpoint: string; previous: string }>;
      thumbnails: string[];
    };
  };
}
