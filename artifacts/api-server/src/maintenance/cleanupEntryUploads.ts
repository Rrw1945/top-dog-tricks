import { pool } from "@workspace/db";
import { readUploadCleanupFences, runUploadCleanup } from "../lib/entryUploadCleanup";
import { logger } from "../lib/logger";
import { reportUploadCleanup } from "../lib/uploadCleanupReporting";
import { uploadCleanupHealthStore } from "../lib/uploadCleanupHealthStore";

try {
  process.exitCode = await reportUploadCleanup(process.argv.slice(2), {
    run: runUploadCleanup,
    readFences: readUploadCleanupFences,
    ...uploadCleanupHealthStore(pool),
    log: (level, data, message) => logger[level](data, message),
  });
} finally {
  try {
    await pool.end();
  } catch {
    logger.error({ event: "entry_upload_cleanup_close_failed" }, "Cleanup database connection could not close");
    process.exitCode = 1;
  }
}
