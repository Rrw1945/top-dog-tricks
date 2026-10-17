import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

// Called only by the development benchmark, after its fresh-index checks.
// Temp tables intentionally exclude autovacuum so the pending-list/maintenance
// checkpoints are reproducible. No planner switches or index options are changed.
export async function benchmarkChurn(client, measure, indexes, fullPlans) {
  const tables = ["review_queue_benchmark", "review_queue_churn_control"];
  await client.query(`CREATE TEMP TABLE review_queue_churn_control
    (LIKE pg_temp.review_queue_benchmark INCLUDING DEFAULTS) ON COMMIT PRESERVE ROWS`);
  await client.query("ALTER TABLE pg_temp.review_queue_churn_control ADD PRIMARY KEY (id)");
  await client.query("INSERT INTO pg_temp.review_queue_churn_control SELECT * FROM pg_temp.review_queue_benchmark");
  await client.query("ANALYZE pg_temp.review_queue_churn_control");
  const settings = await client.query(`SELECT name, setting, unit FROM pg_settings
    WHERE name IN ('server_version', 'gin_pending_list_limit', 'shared_buffers',
      'work_mem', 'maintenance_work_mem', 'autovacuum', 'enable_seqscan',
      'enable_indexscan', 'enable_bitmapscan', 'random_page_cost') ORDER BY name`);
  console.log(JSON.stringify({ churnSettings: settings.rows }));

  async function storage() {
    const sizes = await client.query(`SELECT c.relname AS name,
        pg_relation_size(c.oid)::text AS bytes, c.reloptions
      FROM pg_class c WHERE c.relnamespace = pg_my_temp_schema()
        AND (c.oid IN ('pg_temp.review_queue_benchmark'::regclass,
                      'pg_temp.review_queue_churn_control'::regclass)
          OR c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid IN
             ('pg_temp.review_queue_benchmark'::regclass,
              'pg_temp.review_queue_churn_control'::regclass)))
      ORDER BY c.relname`);
    const pending = [];
    for (const [name] of indexes.slice(1)) {
      const { rows } = await client.query(
        "SELECT * FROM public.pgstatginindex($1::regclass)", [`pg_temp.${name}`],
      );
      pending.push({ name, ...rows[0] });
    }
    return { sizes: sizes.rows, pending };
  }

  async function snapshot(stage) {
    const state = await storage();
    const actual = await measure();
    // The PK-only control follows exactly the same edit history. Compare all
    // ordered pages (including old/new markers and status/cursor combinations).
    const expected = await measure(tables[1], false);
    for (const [name, item] of Object.entries(actual)) {
      assert.deepEqual(item.rows, expected[name].rows, `${stage}/${name}: ordered page`);
      assert.ok(item.ms < 2000, `${stage}/${name}: warm query below 2 seconds`);
    }
    console.log(JSON.stringify({
      churnStage: stage, ...state,
      queries: Object.fromEntries(Object.entries(actual).map(([name, item]) =>
        [name, { ms: item.ms, blocks: item.blocks, indexes: item.indexes,
          rows: item.rows.length, ...(fullPlans ? { plan: item.plan } : {}) }])),
    }));
    return state;
  }

  async function edit(table, round) {
    assert.ok(tables.includes(table));
    const started = performance.now();
    // Revisit the same dispersed 1% of the archive each round. All three indexed
    // names change; some acquire/lose selective markers. Cycle all four statuses.
    const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)
      UPDATE pg_temp.${table} SET
        dog_name = CASE WHEN id % 1000 = 0 AND $1::int % 2 = 1
          THEN 'Dog Quasar edited ' || $1 ELSE 'Dog edited ' || md5((id + $1)::text) END,
        owner_name = CASE WHEN id % 1100 = 0 AND $1::int % 2 = 0
          THEN 'Owner Nebula edited ' || $1 ELSE 'Owner edited ' || md5((id + $1 + 1)::text) END,
        trick_name = CASE WHEN id % 1200 = 0 AND $1::int % 2 = 1
          THEN 'Trick Aurora edited ' || $1 ELSE 'Trick edited ' || md5((id + $1 + 2)::text) END,
        status = ((ARRAY['pending', 'needs_edit', 'approved', 'rejected'])
          [1 + ((id / 100 + $1::int) % 4)])::public.submission_status
      WHERE id % 100 = 0 RETURNING id`, [round]);
    const plan = rows[0]["QUERY PLAN"][0];
    assert.equal(plan.Plan["Actual Rows"], 3000, `${table}: edit count`);
    return { elapsedMs: performance.now() - started, executionMs: plan["Execution Time"],
      rows: plan.Plan["Actual Rows"], localHitBlocks: plan.Plan["Local Hit Blocks"],
      localReadBlocks: plan.Plan["Local Read Blocks"],
      localDirtiedBlocks: plan.Plan["Local Dirtied Blocks"],
      localWrittenBlocks: plan.Plan["Local Written Blocks"],
      walBytes: plan.Plan["WAL Bytes"], ...(fullPlans ? { plan } : {}) };
  }

  const fresh = await snapshot("fresh");
  assert.ok(fresh.pending.every((p) => Number(p.pending_pages) === 0));
  let sawPending = false;
  for (let round = 1; round <= 4; round++) {
    // Alternate order to reduce a systematic first-writer timing bias.
    const writes = {};
    for (const table of round % 2 ? tables : [...tables].reverse()) {
      writes[table] = await edit(table, round);
    }
    const state = await snapshot(`edited-${round}`);
    sawPending ||= state.pending.some((p) => Number(p.pending_pages) > 0);
    console.log(JSON.stringify({ churnRound: round, writes }));
  }
  assert.ok(sawPending, "Must observe GIN pending-list growth, not only clean indexes");

  // ANALYZE updates planner statistics but is not pending-list cleanup.
  for (const table of tables) await client.query(`ANALYZE pg_temp.${table}`);
  await snapshot("analyzed");
  const maintenance = {};
  for (const table of tables) {
    const started = performance.now();
    await client.query(`VACUUM (ANALYZE) pg_temp.${table}`);
    maintenance[table] = { elapsedMs: performance.now() - started };
  }
  console.log(JSON.stringify({ churnMaintenance: maintenance }));
  const maintained = await snapshot("vacuum-analyzed");
  assert.ok(maintained.pending.every((p) => Number(p.pending_pages) === 0),
    "VACUUM must drain all three GIN pending lists");
  console.log("Churn passed: 12,000 edits per fixture, identical control pages at every checkpoint, pending growth and VACUUM cleanup observed.");
}
