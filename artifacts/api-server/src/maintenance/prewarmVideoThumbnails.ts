import { parsePrewarmOptions, PREWARM_USAGE, runThumbnailPrewarm } from './thumbnailPrewarm';

// Load runtime dependencies only after validating arguments (including --help).
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(PREWARM_USAGE);
    return;
  }
  let options;
  try {
    options = parsePrewarmOptions(args);
  } catch {
    console.error(PREWARM_USAGE);
    process.exitCode = 2;
    return;
  }

  const { db, pool, submissionsTable: table } = await import('@workspace/db');
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const { and, asc, eq, gt, lte, isNotNull, ne } = await import('drizzle-orm');
    // Dry-run does not even initialize storage or load the renderer.
    const prepare = options.apply
      ? await (async () => {
          const [{ durableVideoThumbnail }, { ObjectStorageService }] = await Promise.all([
            import('../lib/durableVideoThumbnail'), import('../lib/objectStorage'),
          ]);
          const storage = new ObjectStorageService();
          return async (path: string) =>
            durableVideoThumbnail(path, await storage.getObjectEntityFile(path));
        })()
      : async () => { throw new Error('Dry-run must not prepare media'); };
    const summary = await runThumbnailPrewarm(options, {
      select: async (bounds) => {
        const rows = await db.select({
          id: table.id, processedVideoObjectPath: table.processedVideoObjectPath,
        }).from(table).where(and(
          eq(table.processingStatus, 'completed'),
          isNotNull(table.processedVideoObjectPath),
          ne(table.processedVideoObjectPath, ''),
          gt(table.id, bounds.afterId),
          lte(table.id, bounds.throughId),
        )).orderBy(asc(table.id)).limit(bounds.limit + 1);
        return rows.map(row => ({
          id: row.id, processedVideoObjectPath: row.processedVideoObjectPath!,
        }));
      },
      prepare,
      report: event => console.log(JSON.stringify(event)),
      stopped: () => interrupted,
    });
    console.log(JSON.stringify(summary));
    if (summary.failedIds.length || summary.interrupted) process.exitCode = 1;
  } finally {
    await pool.end();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

void main().catch(() => {
  // Do not print raw database/storage errors or their private request details.
  console.error(JSON.stringify({ type: 'fatal', code: 'PREWARM_FAILED' }));
  process.exitCode = 1;
});
