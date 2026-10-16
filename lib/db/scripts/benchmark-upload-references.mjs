import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

// A disposable namespace, synthetic rows only; never reads real submissions.
if (process.env.NODE_ENV === "production") throw new Error("Development-only fixture.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const peer = new pg.Client({ connectionString: process.env.DATABASE_URL });
const schema = `upload_refs_test_${process.pid}`;
const installer = await readFile(new URL("./install-upload-cleanup.sql", import.meta.url), "utf8");
const id = "12345678-1234-1234-1234-123456789abc";
const missing = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const fields = ["video_object_path", "signature_object_path", "processed_video_object_path", "voiceover_object_path"];
const nodes = p => [p, ...(p.Plans ?? []).flatMap(nodes)];
async function plan(label, query, params) {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params);
  const p = rows[0]["QUERY PLAN"][0];
  const blocks = (p.Plan["Shared Hit Blocks"] ?? 0) + (p.Plan["Shared Read Blocks"] ?? 0);
  console.log(JSON.stringify({ label, ms: p["Execution Time"], blocks,
    indexes: nodes(p.Plan).map(n => n["Index Name"]).filter(Boolean) }));
  return { p, blocks };
}
async function rejected(sql, params) {
  await assert.rejects(client.query(sql, params), /Referenced upload has expired/);
}
await client.connect();
await peer.connect();
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await peer.query(`SET search_path TO ${schema}`);
  await client.query(`CREATE TABLE submissions (
    id integer PRIMARY KEY, status text, note text, video_object_path text,
    signature_object_path text, processed_video_object_path text, voiceover_object_path text
  )`);
  await client.query(`INSERT INTO submissions VALUES (0, 'rejected', NULL, $1)`, [`https://alias.invalid/x${id}suffix`]);
  await assert.rejects(client.query("SELECT entry_upload_has_reference($1)", [id]),
    /does not exist/, "uninitialized deployment must fail closed");
  async function install() {
    await client.query("BEGIN");
    await client.query(installer);
    await client.query("COMMIT");
  }
  await install();
  const referenced = async token => (await client.query(
    "SELECT entry_upload_has_reference($1) AS referenced", [token])).rows[0].referenced;
  assert.ok(await referenced(id), "backfilled rejected alias");
  await install();
  assert.ok(await referenced(id), "idempotent backfill");
  await client.query("DELETE FROM submissions");
  assert.equal(await referenced(id), false);
  await client.query("BEGIN");
  await client.query("INSERT INTO submissions(id,video_object_path) VALUES (1,$1)", [id]);
  assert.ok(await referenced(id));
  await client.query("ROLLBACK");
  assert.equal(await referenced(id), false, "rolled back sources cannot leave derived rows");

  // Compare exact legacy substring semantics including overlapping tokens.
  for (const value of [null, "", id, `a${id}b`, id + id, `https://x/${id}?other=${missing}`, id.toUpperCase()]) {
    const tokens = (await client.query("SELECT entry_upload_reference_tokens($1) AS tokens", [value])).rows[0].tokens;
    for (const token of [id, missing, ...(value?.match(/[a-f0-9-]{36}/g) ?? [])]) {
      assert.equal(tokens.includes(token), value?.includes(token) ?? false);
    }
  }
  for (const status of ["pending", "approved", "rejected", "needs_edit", "archived"]) {
    for (const field of fields) {
      await client.query(`INSERT INTO submissions (id, status, ${field}) VALUES (1, $1, $2)`,
        [status, `https://alias.invalid/anything/prefix${id}suffix`]);
      assert.ok(await referenced(id), `${status}/${field}`);
      await client.query(`UPDATE submissions SET ${field}=NULL WHERE id=1`);
      assert.equal(await referenced(id), false);
      await client.query("DELETE FROM submissions WHERE id=1");
    }
  }
  await client.query("INSERT INTO protected_media VALUES ($1)", [`alias:${id}`]);
  assert.ok(await referenced(id));
  await client.query("UPDATE protected_media SET object_path=$1", [`alias:${missing}`]);
  assert.equal(await referenced(id), false);
  assert.ok(await referenced(missing));
  await client.query("TRUNCATE protected_media");
  assert.equal(await referenced(missing), false);
  await client.query("INSERT INTO entry_uploads(object_path, state) VALUES ($1, 'deleting'), ($2, 'deleted')",
    [`/objects/uploads/${id}`, "/objects/uploads/legacy-id"]);
  await rejected("INSERT INTO submissions(id,note) VALUES (1,$1)", [`unrelated field ${id}`]);
  await rejected("INSERT INTO protected_media VALUES ($1)", [`alias:${id}`]);
  await rejected("INSERT INTO protected_media VALUES ('alias:legacy-id')");
  // Fences still wait for cleanup ownership and inspect the committed state.
  await client.query("BEGIN");
  await client.query("UPDATE entry_uploads SET state='issued' WHERE object_path=$1", [`/objects/uploads/${id}`]);
  await peer.query("SET lock_timeout='150ms'");
  await assert.rejects(peer.query("INSERT INTO protected_media VALUES ($1)", [`alias:${id}`]), /lock timeout/);
  await client.query("UPDATE entry_uploads SET state='deleted' WHERE object_path=$1", [`/objects/uploads/${id}`]);
  await client.query("COMMIT");
  await assert.rejects(peer.query("INSERT INTO protected_media VALUES ($1)", [`alias:${id}`]), /Referenced upload has expired/);
  await client.query("UPDATE entry_uploads SET state='issued' WHERE object_path=$1", [`/objects/uploads/${id}`]);
  await client.query("BEGIN");
  await client.query("INSERT INTO protected_media VALUES ($1)", [`alias:${id}`]);
  await assert.rejects(peer.query("SELECT * FROM entry_uploads WHERE object_path=$1 FOR UPDATE",
    [`/objects/uploads/${id}`]), /lock timeout/, "attachment keeps its fence until commit");
  await client.query("COMMIT");
  assert.ok(await referenced(id), "committed attachment visible to cleanup");
  await client.query("TRUNCATE protected_media");
  await client.query("TRUNCATE entry_uploads");

  // 100k and 300k mixed-status submissions with four distinct media URLs;
  // half as many administrative reservations and an equally large registry.
  for (const size of [100000, 300000]) {
    await client.query(`INSERT INTO submissions
      SELECT n, (ARRAY['pending','approved','rejected','needs_edit'])[1+n%4], repeat('metadata ',20),
        'https://cdn.invalid/objects/uploads/' || md5(n::text)::uuid,
        '/objects/accepted/' || md5(('signature'||n)::text)::uuid,
        '/objects/accepted/' || md5(('processed'||n)::text)::uuid,
        '/objects/accepted/' || md5(('voice'||n)::text)::uuid
      FROM generate_series($1::int,$2::int) n`, [size === 100000 ? 1 : 100001, size]);
    await client.query(`INSERT INTO protected_media
      SELECT 'https://admin.invalid/' || md5(('admin'||n)::text)::uuid
      FROM generate_series($1::int,$2::int) n`, [size === 100000 ? 1 : 50001, size / 2]);
    await client.query(`INSERT INTO entry_uploads(object_path)
      SELECT '/objects/uploads/' || md5(n::text)::uuid
      FROM generate_series($1::int,$2::int) n`, [size === 100000 ? 1 : 100001, size]);
    for (const table of ["submissions", "protected_media", "entry_upload_references", "entry_uploads"]) {
      await client.query(`ANALYZE ${table}`);
    }
    const lastId = (await client.query("SELECT md5($1)::uuid::text AS id", [String(size)])).rows[0].id;
    for (const [name, token] of [["missing", missing], ["late-hit", lastId]]) {
      const old = await plan(`${size}/legacy/${name}`,
        `SELECT 1 FROM submissions WHERE ${fields.map(f => `${f} LIKE $1`).join(" OR ")} LIMIT 1`, [`%${token}%`]);
      const fast = await plan(`${size}/indexed/${name}`,
        "SELECT 1 FROM entry_upload_references WHERE token=$1 LIMIT 1", [token]);
      assert.ok(nodes(fast.p.Plan).some(p => p["Index Name"] === "entry_upload_references_pkey"));
      assert.ok(fast.blocks * 10 < old.blocks, "reference lookup must cut buffers by >90%");
      assert.equal(await referenced(token), name === "late-hit", "API lookup agrees");
    }
    const adminOld = await plan(`${size}/legacy-admin-missing`,
      "SELECT 1 FROM protected_media WHERE object_path LIKE $1 LIMIT 1", [`%${missing}%`]);
    const adminFast = await plan(`${size}/indexed-admin-missing`,
      "SELECT 1 FROM entry_upload_references WHERE token=$1 LIMIT 1", [missing]);
    assert.ok(adminFast.blocks * 10 < adminOld.blocks);
    await plan(`${size}/api-lookup`, "SELECT entry_upload_has_reference($1)", [lastId]);
    const row = JSON.stringify({ video_object_path: `https://alias/${lastId}`, note: "fixture" });
    const old = await plan(`${size}/legacy-fence`,
      "SELECT object_path,state FROM entry_uploads WHERE position(split_part(object_path,'/',4) in $1)>0 ORDER BY object_path FOR UPDATE", [row]);
    const fast = await plan(`${size}/indexed-fence`,
      `SELECT object_path,state FROM entry_uploads WHERE object_path IN (
        SELECT object_path FROM entry_uploads WHERE split_part(object_path,'/',4)=ANY(entry_upload_reference_tokens($1))
        UNION ALL SELECT object_path FROM entry_uploads
          WHERE split_part(object_path,'/',4) !~ '^[a-f0-9-]{36}$'
          AND position(split_part(object_path,'/',4) in $1)>0
      ) ORDER BY object_path FOR UPDATE`, [row]);
    assert.ok(nodes(fast.p.Plan).some(p => p["Index Name"] === "entry_uploads_reference_id_idx"));
    assert.ok(fast.blocks * 10 < old.blocks, "write fence must cut buffers by >90%");
    console.log(JSON.stringify({ label: `${size}/storage`, ...(await client.query(`
      SELECT count(*)::int AS references,
        pg_total_relation_size('entry_upload_references')::float8 AS bytes
      FROM entry_upload_references`)).rows[0] }));
  }
  console.log("Upload reference correctness, locking and plan checks passed.");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await peer.end();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}
