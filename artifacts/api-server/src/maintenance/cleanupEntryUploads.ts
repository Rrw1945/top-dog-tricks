import { pool } from "@workspace/db";
import { runUploadCleanup } from "../lib/entryUploadCleanup";
import { logger } from "../lib/logger";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply")) throw new Error("Usage: cleanup-entry-uploads [--apply]");
try {
  const counts = await runUploadCleanup(args.includes("--apply"));
  logger.info({ apply: args.includes("--apply"), counts }, "Entry upload cleanup finished");
  if (counts.failed) process.exitCode = 1;
} finally {
  await pool.end();
}
