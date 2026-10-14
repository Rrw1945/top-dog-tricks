import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

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
