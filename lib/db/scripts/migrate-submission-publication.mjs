import { readFile } from "node:fs/promises";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query(await readFile(new URL("./submission-publication.sql", import.meta.url), "utf8"));
} finally {
  await client.end();
}
