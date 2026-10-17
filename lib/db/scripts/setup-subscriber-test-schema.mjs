import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// This is intentionally NOT a general database migration entrypoint.
export function assertSubscriberTestDatabase(env) {
  assert.notEqual(env.NODE_ENV, "production", "Test setup cannot run in production");
  assert.notEqual(env.REPLIT_DEPLOYMENT, "1", "Test setup cannot run in a deployment");
  const url = new URL(env.DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "Subscriber tests require a local disposable PostgreSQL service");
  assert.equal(url.pathname, "/subscriber_notifications",
    "Subscriber tests require the dedicated subscriber_notifications database");
  assert.equal(url.search, "", "Test database connection options are not allowed");
}

export async function verifySubscriberTestSchema(client) {
  // Drizzle has returned zero after SQL errors in hosted runs. Check the actual
  // database as well as its explicit completion marker, including late DDL.
  await client.query(`
    SELECT s.id, s.email, s.verified_at, s.welcome_email_status,
      n.submission_id, n.subscriber_id, n.status, e.processing_status
    FROM public.subscribers s
    CROSS JOIN public.spotlight_notifications n
    CROSS JOIN public.submissions e LIMIT 0
  `);
  const { rows } = await client.query(`
    SELECT c.opcname FROM pg_opclass c
    JOIN pg_namespace n ON n.oid = c.opcnamespace
    WHERE n.nspname = 'public' AND c.opcname = 'gin_trgm_ops'
  `);
  assert.equal(rows.length, 1, "Missing public.gin_trgm_ops");
  const indexes = await client.query(`
    SELECT i.indexrelid::regclass::text AS name
    FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class idx ON idx.oid = i.indexrelid
    WHERE n.nspname = 'public'
      AND idx.relname IN ('subscribers_email_idx',
        'spotlight_notifications_submission_subscriber_idx')
      AND i.indisunique AND i.indisvalid AND i.indisready
  `);
  assert.equal(indexes.rows.length, 2, "Missing valid subscriber uniqueness indexes");
}

export async function setupSubscriberTestSchema({
  env = process.env,
  run = spawnSync,
  client = new pg.Client({ connectionString: env.DATABASE_URL }),
} = {}) {
  assertSubscriberTestDatabase(env);
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  for (const script of ["prepare-review-search.mjs", "push-schema.mjs"]) {
    const result = run(process.execPath, [`scripts/${script}`], {
      cwd, env, stdio: "inherit",
    });
    assert.ok(!result.error && !result.signal && result.status === 0,
      `Subscriber test setup failed during ${script}`);
  }
  await client.connect();
  try {
    await verifySubscriberTestSchema(client);
  } finally {
    await client.end();
  }
  console.log("Disposable subscriber test schema verified.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await setupSubscriberTestSchema();
}
