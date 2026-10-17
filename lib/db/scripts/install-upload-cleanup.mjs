import pg from "pg";
import { readFile } from "node:fs/promises";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(await readFile(new URL("./install-upload-cleanup.sql", import.meta.url), "utf8"));
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
