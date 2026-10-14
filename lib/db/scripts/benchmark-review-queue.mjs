import assert from "node:assert/strict";
import pg from "pg";

// Synthetic data only, on one connection-local table. Never reads contest rows.
if (process.env.NODE_ENV === "production") {
  throw new Error("Run this synthetic benchmark against development only.");
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const indexes = [
  ["submissions_review_status_id_idx", "btree (status, id DESC)"],
  ["submissions_review_dog_search_idx", "gin (dog_name gin_trgm_ops)"],
  ["submissions_review_owner_search_idx", "gin (owner_name gin_trgm_ops)"],
  ["submissions_review_trick_search_idx", "gin (trick_name gin_trgm_ops)"],
];
const nodes = (node) => [node, ...(node.Plans ?? []).flatMap(nodes)];
const cases = [
  ["all-first", "", []],
  ["all-deep", "id < $1", [150000]],
  ["status-first", "status = $1", ["needs_edit"]],
  ["status-deep", "status = $1 AND id < $2", ["needs_edit", 150000]],
  ["status-max-page", "status = $1 AND id < $2", ["needs_edit", 150000], 101],
  ["status-majority", "status = $1", ["approved"]],
  ["status-pending", "status = $1", ["pending"]],
  ["status-rejected", "status = $1", ["rejected"]],
  ["search-dog", "", ["%qUaSaR%"]],
  ["search-owner", "", ["%Nebula%"]],
  ["search-trick", "", ["%Aurora%"]],
  ["search-combined", "status = $1 AND id < $2", ["approved", 250000, "%Quasar%"]],
  ["search-deep", "id < $1", [150000, "%Quasar%"]],
  ["search-rare-status", "status = $1", ["needs_edit", "%Quasar%"]],
  ["search-missing", "", ["%absentneedle%"]],
  ["search-common", "", ["%Dog%"]],
  ["search-short", "", ["%og%"]],
  ["search-short-missing", "", ["%zx%"]],
  ["search-literal", "", ["%Rate\\%\\_\\\\%"]],
];

async function measure() {
  const result = {};
  for (const [name, predicate, params, limit = 51] of cases) {
    const search = name.startsWith("search-");
    const clauses = [predicate, search
      ? `(dog_name ILIKE $${params.length} ESCAPE '\\' OR owner_name ILIKE $${params.length} ESCAPE '\\' OR trick_name ILIKE $${params.length} ESCAPE '\\')`
      : ""].filter(Boolean);
    const query = `SELECT id, dog_name, owner_name, trick_name, status
      FROM review_queue_benchmark ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY id DESC LIMIT ${limit}`;
    const rows = (await client.query(query, params)).rows;
    const samples = [];
    let plan;
    for (let run = 0; run < 3; run++) {
      const explained = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params,
      );
      plan = explained.rows[0]["QUERY PLAN"][0];
      samples.push(plan["Execution Time"]);
    }
    result[name] = {
      rows,
      ms: samples.sort((a, b) => a - b)[1],
      blocks: (plan.Plan["Shared Hit Blocks"] ?? 0) + (plan.Plan["Shared Read Blocks"] ?? 0)
        + (plan.Plan["Local Hit Blocks"] ?? 0) + (plan.Plan["Local Read Blocks"] ?? 0),
      indexes: nodes(plan.Plan).map((n) => n["Index Name"]).filter(Boolean),
      plan,
    };
  }
  return result;
}

await client.connect();
try {
  if (!process.argv.includes("--explore")) {
    // Normal regression runs require the rolled-out schema; a missing index
    // must not be hidden by the synthetic fixture's candidate indexes.
    for (const [name, definition] of indexes) {
      const { rows } = await client.query(
        `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid, i.indisready
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'public.submissions'::regclass AND c.relname = $1`, [name],
      );
      assert.equal(rows.length, 1, `Missing ${name}; apply the development schema first`);
      assert.ok(rows[0].indisvalid && rows[0].indisready, `${name} is not usable`);
      assert.ok(rows[0].definition.endsWith(`USING ${definition}`), `${name}: unexpected definition`);
    }
  }
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  await client.query("CREATE TEMP TABLE review_queue_benchmark (LIKE public.submissions INCLUDING DEFAULTS) ON COMMIT DROP");
  await client.query("ALTER TABLE review_queue_benchmark ADD PRIMARY KEY (id)");
  await client.query(`
    INSERT INTO review_queue_benchmark
      (id, owner_name, dog_name, trick_name, status, email, phone, trick_description,
       video_object_path, video_file_name, video_content_type, signature_object_path)
    SELECT n,
      CASE WHEN n % 12001 = 0 THEN 'Owner Nebula' ELSE 'Owner ' || md5(n::text) END,
      CASE WHEN n % 10007 = 0 THEN 'Dog Quasar'
           WHEN n = 77777 THEN E'Rate%_\\\\' ELSE 'Dog ' || md5((n + 1)::text) END,
      CASE WHEN n % 13001 = 0 THEN 'Trick Aurora' ELSE 'Trick ' || md5((n + 2)::text) END,
      (CASE WHEN n % 1000 = 0 THEN 'needs_edit'
            WHEN n % 100 = 1 THEN 'pending'
            WHEN n % 10 = 2 THEN 'rejected' ELSE 'approved' END)::submission_status,
      'synthetic@example.invalid', '', repeat('Synthetic trick description ', 12),
      '/synthetic/video', 'synthetic.mp4', 'video/mp4', '/synthetic/signature'
    FROM generate_series(1, 300000) n
  `);
  await client.query("ANALYZE review_queue_benchmark");
  const baseline = await measure();
  for (const [name, definition] of indexes) {
    await client.query(`CREATE INDEX ${name} ON review_queue_benchmark USING ${definition}`);
  }
  await client.query("ANALYZE review_queue_benchmark");
  const indexed = await measure();
  const size = await client.query(`
    SELECT pg_size_pretty(pg_relation_size(indexrelid)) AS size, indexrelname AS name
    FROM pg_stat_all_indexes WHERE relid = 'pg_temp.review_queue_benchmark'::regclass
  `);
  console.log(JSON.stringify({ fixtureIndexSizes: size.rows }));
  for (const [name, , , limit = 51] of cases) {
    assert.deepEqual(indexed[name].rows, baseline[name].rows, `${name}: identical ordered page`);
    assert.ok(indexed[name].rows.length <= limit);
    console.log(JSON.stringify({
      case: name, baselineMs: baseline[name].ms, indexedMs: indexed[name].ms,
      baselineBlocks: baseline[name].blocks, indexedBlocks: indexed[name].blocks,
      indexes: indexed[name].indexes, rows: indexed[name].rows.length,
    }));
  }
  assert.equal(indexed["search-dog"].rows.length, 29);
  assert.equal(indexed["search-owner"].rows.length, 24);
  assert.equal(indexed["search-trick"].rows.length, 23);
  assert.equal(indexed["search-literal"].rows.length, 1);
  assert.equal(indexed["search-missing"].rows.length, 0);
  assert.equal(indexed["search-short-missing"].rows.length, 0);
  assert.equal(indexed["status-max-page"].rows.length, 101);
  for (const name of ["status-first", "status-deep", "status-max-page"]) {
    assert.ok(indexed[name].indexes.includes(indexes[0][0]), `${name}: status/ID index`);
    assert.ok(indexed[name].blocks < baseline[name].blocks / 3, `${name}: bounded page reads`);
  }
  for (const name of ["search-dog", "search-owner", "search-trick", "search-combined", "search-missing", "search-literal"]) {
    for (const [index] of indexes.slice(1)) {
      assert.ok(indexed[name].indexes.includes(index), `${name}: OR search uses ${index}`);
    }
    assert.ok(indexed[name].blocks < baseline[name].blocks / 5, `${name}: selective search reads`);
  }
  // Timing varies on shared hosts: a broad ceiling catches catastrophic regressions;
  // deterministic plan and buffer assertions above are the primary performance gates.
  for (const [name, item] of Object.entries(indexed)) {
    assert.ok(item.ms < 2000, `${name}: warm page must finish within 2s`);
  }
  if (process.argv.includes("--plans")) {
    console.log(JSON.stringify({ baseline, indexed }, null, 2));
  }
  console.log("Review queue benchmark passed (300,000 synthetic entries; transaction rolled back).");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
