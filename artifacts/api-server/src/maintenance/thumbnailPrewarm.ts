/** Pure bounded runner: database/storage adapters live in the CLI entrypoint. */
export type PrewarmOptions = {
  apply: boolean;
  afterId: number;
  throughId: number;
  limit: number;
};

export const PREWARM_USAGE =
  'Usage: prewarm-video-thumbnails [--dry-run | --apply] [--after-id N] [--through-id N] [--limit N (1-1000)]';

export function parsePrewarmOptions(args: string[]): PrewarmOptions {
  const options: PrewarmOptions = {
    apply: false, afterId: 0, throughId: 2147483647, limit: 100,
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error(PREWARM_USAGE);
    seen.add(arg);
    if (arg === '--apply' || arg === '--dry-run') {
      options.apply = arg === '--apply';
    } else if (arg === '--after-id' || arg === '--through-id' || arg === '--limit') {
      const raw = args[++i];
      if (!raw || !/^\d+$/.test(raw)) throw new Error(PREWARM_USAGE);
      const value = Number(raw);
      const max = arg === '--limit' ? 1000 : 2147483647;
      const min = arg === '--after-id' ? 0 : 1;
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(PREWARM_USAGE);
      }
      if (arg === '--after-id') options.afterId = value;
      if (arg === '--through-id') options.throughId = value;
      if (arg === '--limit') options.limit = value;
    } else {
      // Never echo arbitrary arguments: they may contain a private URL.
      throw new Error(PREWARM_USAGE);
    }
  }
  if ((seen.has('--apply') && seen.has('--dry-run')) || options.afterId > options.throughId) {
    throw new Error(PREWARM_USAGE);
  }
  return options;
}

export type ThumbnailCandidate = { id: number; processedVideoObjectPath: string };
type Progress = {
  type: 'item';
  id: number;
  status: 'would_prepare' | 'ready' | 'failed';
  resumeAfterId: number;
};
export type PrewarmDependencies = {
  // Must return eligible rows in ascending ID order, at most limit + 1.
  select: (options: PrewarmOptions) => Promise<ThumbnailCandidate[]>;
  prepare: (path: string) => Promise<unknown>;
  report: (event: Progress) => void;
  stopped?: () => boolean;
};

export async function runThumbnailPrewarm(options: PrewarmOptions, deps: PrewarmDependencies) {
  const rows = await deps.select(options);
  let resumeAfterId = options.afterId;
  let scannedThroughId = options.afterId;
  let attempted = 0;
  let ready = 0;
  const failedIds: number[] = [];
  for (const row of rows.slice(0, options.limit)) {
    if (deps.stopped?.()) break;
    let status: Progress['status'] = 'would_prepare';
    if (options.apply) {
      try {
        await deps.prepare(row.processedVideoObjectPath);
        status = 'ready';
        ready++;
      } catch {
        // Exception messages, paths, URLs, and ffmpeg stderr are private.
        status = 'failed';
        failedIds.push(row.id);
      }
    }
    attempted++;
    scannedThroughId = row.id;
    // Freeze at the last successful item before the first failure. Re-running
    // later successful items is cheap because durable thumbnails are reused.
    if (failedIds.length === 0) resumeAfterId = row.id;
    deps.report({ type: 'item', id: row.id, status, resumeAfterId });
  }
  return {
    type: 'summary' as const,
    mode: options.apply ? 'apply' : 'dry-run',
    attempted, ready, failedIds, resumeAfterId, scannedThroughId,
    throughId: options.throughId,
    hasMore: rows.length > attempted,
    interrupted: deps.stopped?.() ?? false,
  };
}
