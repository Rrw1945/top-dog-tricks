import type { CleanupHealth } from "./uploadCleanupReporting";

interface QueryClient {
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
}

const projection = `total_runs AS "totalRuns", failed_runs AS "failedRuns",
  failed_objects AS "failedObjects", consecutive_failures AS "consecutiveFailures",
  last_finished_at AS "lastFinishedAt", last_failure_at AS "lastFailureAt"`;

export function uploadCleanupHealthStore(client: QueryClient) {
  return {
    async read(): Promise<CleanupHealth> {
      const result = await client.query(`SELECT ${projection}
        FROM entry_upload_cleanup_health WHERE id = 1`);
      if (!result.rows[0]) throw new Error("Cleanup health migration required");
      return result.rows[0];
    },
    async record(failed: boolean, failedObjects: number): Promise<CleanupHealth> {
      // One atomic update serializes concurrent completions, without taking any
      // upload locks or changing the deletion protocol.
      const result = await client.query(`UPDATE entry_upload_cleanup_health SET
        total_runs = total_runs + 1,
        failed_runs = failed_runs + $1,
        failed_objects = failed_objects + $2,
        consecutive_failures = CASE WHEN $1 = 1 THEN consecutive_failures + 1 ELSE 0 END,
        last_finished_at = clock_timestamp(),
        last_failure_at = CASE WHEN $1 = 1 THEN clock_timestamp() ELSE last_failure_at END
        WHERE id = 1 RETURNING ${projection}`, [failed ? 1 : 0, failedObjects]);
      if (!result.rows[0]) throw new Error("Cleanup health migration required");
      return result.rows[0];
    },
  };
}
