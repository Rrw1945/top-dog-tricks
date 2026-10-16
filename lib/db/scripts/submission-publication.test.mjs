import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

for (const existingColumn of [false, true]) {
  test(`interrupted publication migration rolls back and retries (${existingColumn ? "existing" : "new"} column)`, async () => {
    assert.ok(process.env.DATABASE_URL, "Development DATABASE_URL required");
    assert.notEqual(process.env.NODE_ENV, "production");
    assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const schema = `publication_${randomUUID().replaceAll("-", "")}`;
    const migration = await readFile(new URL("./submission-publication.sql", import.meta.url), "utf8");
    // Fail after all DDL/backfill statements, without editing the real migration.
    assert.equal((migration.match(/^COMMIT;$/gm) ?? []).length, 1);
    assert.match(migration, /COMMIT;\s*$/);
    const interrupted = migration.replace(/^COMMIT;$/m, () => `
DO $$ BEGIN
  RAISE EXCEPTION 'publication migration interrupted before commit' USING ERRCODE = 'P0001';
END $$;
COMMIT;`);
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE submissions (
        id serial PRIMARY KEY, status text DEFAULT 'pending',
        processing_status text DEFAULT 'queued', processed_video_object_path text,
        title text, updated_at timestamptz DEFAULT now()
        ${existingColumn ? ", published_at timestamptz" : ""})`);
      await client.query(`INSERT INTO submissions
        (status, processing_status, processed_video_object_path, updated_at)
        VALUES ('approved','completed','old-1','2020-03-01'),
          ('approved','completed','old-2','2020-01-01'),
          ('approved','processing','reprocessing','2020-02-01'),
          ('pending','completed','waiting','2020-04-01'),
          ('rejected','completed','hidden','2020-05-01'),
          ('approved','queued',NULL,'2020-06-01')`);
      const snapshot = async () => ({
        rows: (await client.query("SELECT * FROM submissions ORDER BY id")).rows,
        columns: (await client.query(`SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns WHERE table_schema=$1 AND table_name='submissions'
          ORDER BY ordinal_position`, [schema])).rows,
        triggers: (await client.query(`SELECT tgname, pg_get_triggerdef(oid) AS definition
          FROM pg_trigger WHERE tgrelid='submissions'::regclass AND NOT tgisinternal
          ORDER BY tgname`)).rows,
        functions: (await client.query(`SELECT p.proname, pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname=$1 ORDER BY p.proname`, [schema])).rows,
      });
      const before = await snapshot();
      await assert.rejects(client.query(interrupted), {
        code: "P0001", message: "publication migration interrupted before commit",
      });
      // PostgreSQL leaves a failed explicit transaction aborted until rollback.
      await assert.rejects(client.query("SELECT 1"), { code: "25P02" });
      await client.query("ROLLBACK");
      assert.deepEqual(await snapshot(), before,
        "Columns, backfilled rows, trigger and function must all roll back");

      await client.query(migration);
      const after = await snapshot();
      assert.ok(after.columns.some(c => c.column_name === "published_at"));
      assert.deepEqual(after.triggers.map(t => t.tgname), ["submissions_first_publication"]);
      assert.deepEqual(after.functions.map(f => f.proname), ["preserve_submission_publication"]);
      assert.deepEqual(after.rows.map(r => r.published_at?.getTime() ?? null),
        [0, 0, 0, null, null, null]);
      const historicalOrder = async () => (await client.query(`SELECT id FROM submissions
        WHERE status='approved' AND processing_status='completed'
          AND processed_video_object_path IS NOT NULL
        ORDER BY published_at DESC, id DESC`)).rows.map(r => r.id);
      assert.deepEqual(await historicalOrder(), [2, 1]);
      // Edits cannot manufacture a publication date or reorder historical entries.
      await client.query(`UPDATE submissions SET title='Edited', updated_at=now(),
        published_at=now() WHERE id IN (1,2,3)`);
      assert.deepEqual(await historicalOrder(), [2, 1]);
      assert.deepEqual((await snapshot()).rows.slice(0, 3).map(r => r.published_at.getTime()), [0, 0, 0]);
      await client.query("UPDATE submissions SET status='approved' WHERE id=4");
      const firstPublication = (await snapshot()).rows[3].published_at;
      assert.ok(firstPublication.getTime() > 0);
      await client.query("UPDATE submissions SET published_at=NULL, title='Edited again' WHERE id=4");
      assert.deepEqual((await snapshot()).rows[3].published_at, firstPublication);
      assert.deepEqual(await historicalOrder(), [4, 2, 1]);
      const installed = await snapshot();
      await client.query(migration);
      assert.deepEqual(await snapshot(), installed, "Retry remains idempotent after publication");
    } finally {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
}

test("publication ordering survives edits, reprocessing, hiding and repeat migration", async () => {
  assert.ok(process.env.DATABASE_URL, "Development DATABASE_URL required");
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const schema = `publication_${randomUUID().replaceAll("-", "")}`;
  const migration = await readFile(new URL("./submission-publication.sql", import.meta.url), "utf8");
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE submissions (
      id serial PRIMARY KEY, status text DEFAULT 'pending',
      processing_status text DEFAULT 'queued', processed_video_object_path text,
      title text, updated_at timestamptz DEFAULT now())`);
    await client.query(`INSERT INTO submissions (status, processing_status, processed_video_object_path)
      VALUES ('approved','completed','old-1'), ('approved','completed','old-2'),
      ('pending','completed','waiting'), ('rejected','completed','hidden'),
      ('approved','queued',NULL)`);
    await client.query(migration);
    const rows = async () => (await client.query(`SELECT id, published_at FROM submissions
      WHERE status = 'approved' AND processing_status = 'completed'
      AND processed_video_object_path IS NOT NULL
      ORDER BY published_at DESC, id DESC`)).rows;
    assert.deepEqual((await rows()).map(r => r.id), [2, 1]);
    assert.ok((await rows()).every(r => r.published_at.getTime() === 0));
    // Approval after completion and completion after approval must both publish.
    await client.query(`UPDATE submissions SET status='approved' WHERE id=3`);
    const firstPublication = (await rows())[0].published_at;
    assert.ok(firstPublication.getTime() > 0);
    await client.query(`UPDATE submissions SET processing_status='completed',
      processed_video_object_path='new-5' WHERE id=5`);
    assert.deepEqual((await rows()).map(r => r.id), [5, 3, 2, 1]);
    // Routine edits and even explicit timestamp overwrites cannot bump an entry.
    await client.query(`UPDATE submissions SET title='New title', updated_at=now(),
      published_at=now() WHERE id IN (1,3)`);
    await client.query(`UPDATE submissions SET processing_status='processing' WHERE id=3`);
    assert.deepEqual((await rows()).map(r => r.id), [5, 2, 1]);
    await client.query(`UPDATE submissions SET processing_status='completed',
      processed_video_object_path='reprocessed' WHERE id=3`);
    await client.query(`UPDATE submissions SET status='rejected' WHERE id=3`);
    assert.deepEqual((await rows()).map(r => r.id), [5, 2, 1]);
    await client.query(`UPDATE submissions SET status='approved' WHERE id=3`);
    assert.equal((await rows()).find(r => r.id === 3).published_at.getTime(), firstPublication.getTime());
    await client.query(migration);
    assert.deepEqual((await rows()).map(r => r.id), [5, 3, 2, 1]);
    assert.equal((await rows()).find(r => r.id === 1).published_at.getTime(), 0);
    // A completed record inserted directly is also covered by the DB invariant.
    await client.query(`INSERT INTO submissions(status,processing_status,processed_video_object_path)
      VALUES ('approved','completed','direct')`);
    assert.deepEqual((await rows()).slice(0, 3).map(r => r.id), [6, 5, 3]);
  } finally {
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
