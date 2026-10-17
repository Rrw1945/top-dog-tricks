import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { normalizeSubscriberEmails } from "./normalize-subscriber-emails.mjs";

test("failed email normalization rolls back subscribers and spotlight history, then retries", async () => {
  assert.ok(process.env.DATABASE_URL, "Development DATABASE_URL required");
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1");
  const schema = `subscriber_rollback_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    // Exclude public: every fixture and every normalizer statement stays isolated.
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE subscribers (
        id integer PRIMARY KEY, email text NOT NULL UNIQUE,
        verification_token_hash text, unsubscribe_token_hash text NOT NULL,
        verified_at timestamptz, unsubscribed_at timestamptz,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE submissions (id integer PRIMARY KEY);
      CREATE TABLE spotlight_notifications (
        id integer PRIMARY KEY,
        submission_id integer NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        subscriber_id integer NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        status text NOT NULL, claimed_at timestamptz NOT NULL,
        delivered_at timestamptz, failed_at timestamptz, last_error text,
        attempt_count integer NOT NULL, sent_at timestamptz,
        UNIQUE (submission_id, subscriber_id)
      );
      INSERT INTO subscribers VALUES
        (1, ' Legacy@Example.com ', 'verify-1', 'unsubscribe-1',
          '2020-01-01', NULL, '2019-01-01', '2020-01-01'),
        (2, 'legacy@example.com', 'verify-2', 'unsubscribe-2',
          '2020-02-01', '2020-03-01', '2019-02-01', '2020-03-01'),
        (3, 'untouched@example.com', 'verify-3', 'unsubscribe-3',
          NULL, NULL, '2019-03-01', '2020-01-01');
      INSERT INTO submissions VALUES (10), (11), (12);
      INSERT INTO spotlight_notifications VALUES
        (101, 10, 1, 'failed', '2020-01-01', NULL, '2020-01-02', 'fixture failure', 2, NULL),
        (102, 10, 2, 'delivered', '2020-02-01', '2020-02-02', NULL, NULL, 1, '2020-02-02'),
        (103, 11, 2, 'claimed', '2020-03-01', NULL, NULL, NULL, 3, NULL),
        (104, 12, 3, 'delivered', '2020-04-01', '2020-04-02', NULL, NULL, 1, '2020-04-02');
    `);
    const snapshot = async () => ({
      subscribers: (await client.query("SELECT * FROM subscribers ORDER BY id")).rows,
      notifications: (await client.query("SELECT * FROM spotlight_notifications ORDER BY id")).rows,
      submissions: (await client.query("SELECT * FROM submissions ORDER BY id")).rows,
    });
    const before = await snapshot();

    // A real database error after the final UPDATE proves earlier DELETEs and
    // relationship reassignments happened, not merely that BEGIN can roll back.
    await client.query(`
      CREATE FUNCTION fail_after_normalization() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM subscribers WHERE id = 2)
          OR EXISTS (SELECT 1 FROM spotlight_notifications WHERE id = 101)
          OR (SELECT count(*) FROM spotlight_notifications
              WHERE id IN (102, 103) AND subscriber_id = 1) <> 2
          OR NOT EXISTS (SELECT 1 FROM subscribers
              WHERE id = 1 AND email = 'legacy@example.com'
                AND verified_at = '2020-02-01'::timestamptz
                AND unsubscribed_at IS NULL AND verification_token_hash IS NULL)
        THEN
          RAISE EXCEPTION 'fixture did not reach mutated state';
        END IF;
        RAISE EXCEPTION 'injected failure after normalization mutations'
          USING ERRCODE = 'P0001';
      END $$;
      CREATE TRIGGER fail_normalization AFTER UPDATE ON subscribers
        FOR EACH STATEMENT EXECUTE FUNCTION fail_after_normalization();
    `);
    await assert.rejects(normalizeSubscriberEmails(client), {
      code: "P0001", message: "injected failure after normalization mutations",
    });
    // No manual rollback here: the function must restore a usable connection.
    assert.deepEqual(await snapshot(), before,
      "Rollback must restore every original field and notification relationship");
    assert.deepEqual((await client.query(`
      SELECT to_regclass('pg_temp.subscriber_canonical_map') AS mapping,
             to_regclass('pg_temp.subscriber_canonical_state') AS state
    `)).rows, [{ mapping: null, state: null }]);

    await client.query("DROP TRIGGER fail_normalization ON subscribers");
    await normalizeSubscriberEmails(client);
    const after = await snapshot();
    assert.deepEqual(after.submissions, before.submissions);
    assert.deepEqual(after.notifications, before.notifications
      .filter(row => row.id !== 101)
      .map(row => ({ ...row, subscriber_id: row.subscriber_id === 2 ? 1 : row.subscriber_id })));
    const keeper = before.subscribers[0];
    assert.deepEqual(after.subscribers.map(({ updated_at, ...row }) => row),
      [
        { ...keeper, email: "legacy@example.com", verified_at: before.subscribers[1].verified_at,
          unsubscribed_at: null, verification_token_hash: null },
        before.subscribers[2],
      ].map(({ updated_at, ...row }) => row));
    for (const row of after.subscribers) {
      assert.ok(row.updated_at > keeper.updated_at, "Successful retry updates timestamps");
    }
    assert.deepEqual((await client.query(`
      SELECT to_regclass('pg_temp.subscriber_canonical_map') AS mapping,
             to_regclass('pg_temp.subscriber_canonical_state') AS state
    `)).rows, [{ mapping: null, state: null }]);
  } finally {
    try {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  }
});
