import pg from "pg";

// Development schema prerequisite only. Production changes belong to Publish.
if (process.env.NODE_ENV === "production") {
  throw new Error("Review search schema preparation is development-only; use Publish for production.");
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
  const { rows } = await client.query(`
    SELECT 1 FROM pg_opclass c
    JOIN pg_namespace n ON n.oid = c.opcnamespace
    WHERE c.opcname = 'gin_trgm_ops' AND n.nspname = 'public'
  `);
  if (rows.length !== 1) throw new Error("pg_trgm must provide public.gin_trgm_ops before schema push.");
  await client.query("COMMIT");
  console.log("Development review search prerequisite ready.");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
