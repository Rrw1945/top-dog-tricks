import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";

const migration = await readFile(new URL("./submission-publication.sql", import.meta.url), "utf8");

// Observe a real row-lock wait, rather than assuming a sleep caused contention.
// The lock holder can inspect the waiter, so no third connection is needed.
async function waitForBlock(holder, waiterPid, holderPid) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const { rows: [row] } = await holder.query(
      "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
      [holderPid, waiterPid],
    );
    if (row.blocked) return;
    await delay(10);
  }
  assert.fail("Second update never blocked on the first connection's row lock");
}

for (const edit of ["review", "title"]) {
  for (const completionFirst of [true, false]) {
    test(`${edit} races completion (${completionFirst ? "completion" : edit} holds lock first)`,
      { timeout: 30_000 }, async () => {
        assert.ok(process.env.DATABASE_URL, "Development DATABASE_URL required");
        assert.notEqual(process.env.NODE_ENV, "production");
        assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1");
        const clients = Array.from({ length: 2 }, () => new pg.Client({
          connectionString: process.env.DATABASE_URL,
          connectionTimeoutMillis: 5_000,
          statement_timeout: 10_000,
          lock_timeout: 8_000,
        }));
        const [holder, waiter] = clients;
        const connected = [];
        const schema = `publication_race_${randomUUID().replaceAll("-", "")}`;
        let pending;
        try {
          for (const client of clients) {
            await client.connect();
            connected.push(client);
          }
          await holder.query(`CREATE SCHEMA "${schema}"`);
          for (const client of clients) await client.query(`SET search_path TO "${schema}"`);
          await holder.query(`CREATE TABLE submissions (
            id serial PRIMARY KEY, status text DEFAULT 'pending',
            processing_status text DEFAULT 'queued', processed_video_object_path text,
            title text, updated_at timestamptz DEFAULT now())`);
          await holder.query(migration);
          await holder.query(`INSERT INTO submissions (status, title)
            VALUES ($1, 'Original title')`, [edit === "title" ? "approved" : "pending"]);
          const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const waiterPid = (await waiter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const completion = `UPDATE submissions SET processing_status='completed',
            processed_video_object_path='processed', updated_at=clock_timestamp(),
            published_at='2099-01-01' WHERE id=1 RETURNING published_at::text`;
          const editing = edit === "review"
            ? `UPDATE submissions SET status='approved', updated_at=clock_timestamp(),
                published_at='2099-01-01' WHERE id=1 RETURNING published_at::text`
            : `UPDATE submissions SET title='Edited title', updated_at=clock_timestamp(),
                published_at='2099-01-01' WHERE id=1 RETURNING published_at::text`;

          async function race(first, second, onLocked) {
            await holder.query("BEGIN");
            const firstResult = (await holder.query(first)).rows[0];
            // Attach a rejection handler immediately, including on assertion failures.
            pending = waiter.query(second).then(
              result => ({ result }), error => ({ error }),
            );
            await waitForBlock(holder, waiterPid, holderPid);
            await onLocked(firstResult);
            await holder.query("COMMIT");
            const outcome = await pending;
            pending = undefined;
            if (outcome.error) throw outcome.error;
            return outcome.result.rows[0];
          }

          const first = completionFirst ? completion : editing;
          const second = completionFirst ? editing : completion;
          const before = (await holder.query("SELECT clock_timestamp()::text AS time")).rows[0].time;
          let firstPublication;
          let eligibilityBoundary;
          const finalUpdate = await race(first, second, async row => {
            const publishesFirst = edit === "title" && completionFirst;
            assert.equal(row.published_at !== null, publishesFirst,
              "Only an approved, completed submission with an asset may publish");
            firstPublication = row.published_at;
            // When the first update is ineligible, publication must occur after
            // this boundary, not at the blocked statement's earlier start time.
            eligibilityBoundary = (await holder.query(
              "SELECT clock_timestamp()::text AS time",
            )).rows[0].time;
            if (publishesFirst) {
              // A newer submission publishes while the competing edit waits.
              // Restamping the edited row would incorrectly move it above this.
              await holder.query(`INSERT INTO submissions
                (status, processing_status, processed_video_object_path)
                VALUES ('approved', 'completed', 'newer')`);
            }
          });
          assert.ok(finalUpdate.published_at);
          if (firstPublication !== null) {
            assert.equal(finalUpdate.published_at, firstPublication,
              "The blocked edit must preserve the exact first publication instant");
          }
          const { rows: [state] } = await holder.query(`SELECT status, processing_status,
            processed_video_object_path, title, published_at::text,
            published_at >= $1::timestamptz AND published_at <= clock_timestamp() AS in_window
            FROM submissions WHERE id=1`, [firstPublication ? before : eligibilityBoundary]);
          assert.equal(state.in_window, true);
          assert.equal(state.status, "approved");
          assert.equal(state.processing_status, "completed");
          assert.equal(state.processed_video_object_path, "processed");
          assert.equal(state.title, edit === "title" ? "Edited title" : "Original title");
          assert.equal(state.published_at, finalUpdate.published_at);
          if (firstPublication === null) {
            await holder.query(`INSERT INTO submissions
              (status, processing_status, processed_video_object_path)
              VALUES ('approved', 'completed', 'newer')`);
          }
          const order = async () => (await holder.query(`SELECT id FROM submissions
            WHERE status='approved' AND processing_status='completed'
              AND processed_video_object_path IS NOT NULL
            ORDER BY published_at DESC, id DESC`)).rows.map(row => row.id);
          assert.deepEqual(await order(), [2, 1]);
          // Race again in the opposite order once published. Both statements
          // attempt a future timestamp overwrite, which must never affect order.
          const repeated = await race(second, first, async row => {
            assert.equal(row.published_at, state.published_at);
          });
          assert.equal(repeated.published_at, state.published_at);
          assert.deepEqual(await order(), [2, 1]);
        } finally {
          // Release the holder before draining the waiter, even if assertions fail.
          try {
            if (connected.includes(holder)) await holder.query("ROLLBACK");
            if (pending) await pending;
            if (connected.includes(holder)) {
              await holder.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            }
          } finally {
            await Promise.all(connected.map(client => client.end()));
          }
        }
      });
  }
}
