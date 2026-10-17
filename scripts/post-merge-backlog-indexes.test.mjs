import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const dbDir = path.join(root, "lib/db");
const require = createRequire(path.join(dbDir, "package.json"));
const { Client } = require("pg");
const indexes = [
  "subscribers_welcome_failed_backlog_idx",
  "subscribers_welcome_expired_backlog_idx",
];

test("development post-merge bootstraps an empty schema, normalizes existing subscribers, and restores backlog indexes", { timeout: 180_000 }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required; run against the development database");
  assert.notEqual(process.env.NODE_ENV, "production", "This test is development-only");
  assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1", "Never run in a deployment");
  const schema = `post_merge_backlog_${randomUUID().replaceAll("-", "")}`;
  const fixture = await mkdtemp(path.join(tmpdir(), "post-merge-backlog-"));
  const fixtureDb = path.join(fixture, "lib/db");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await mkdir(fixtureDb, { recursive: true });
    await cp(path.join(dbDir, "src"), path.join(fixtureDb, "src"), { recursive: true });
    await cp(path.join(dbDir, "scripts"), path.join(fixtureDb, "scripts"), { recursive: true });
    await cp(path.join(dbDir, "package.json"), path.join(fixtureDb, "package.json"));
    await symlink(path.join(dbDir, "node_modules"), path.join(fixtureDb, "node_modules"), "dir");
    await writeFile(path.join(fixture, "package.json"), '{"private":true}');
    await writeFile(path.join(fixture, "pnpm-workspace.yaml"), "packages:\n  - lib/db\n");

    // Keep the real declarations, including all index definitions, changing only
    // their namespace. A search_path alone cannot isolate pgTable's public DDL.
    for (const name of ["engagement.ts", "submissions.ts", "entry-uploads.ts", "upload-cleanup-health.ts"]) {
      const file = path.join(fixtureDb, "src/schema", name);
      const source = await readFile(file, "utf8");
      await writeFile(file,
        `import { pgSchema as testPgSchema } from "drizzle-orm/pg-core";\n` +
        `${name === "submissions.ts" ? "export " : ""}const testSchema = testPgSchema("${schema}");\n` +
        source.replace(/\bpgTable\(/g, "testSchema.table(").replace(/\bpgEnum\(/g, "testSchema.enum("));
    }
    const config = await readFile(path.join(dbDir, "drizzle.config.ts"), "utf8");
    await writeFile(path.join(fixtureDb, "drizzle.config.ts"),
      config.replace("dialect: \"postgresql\",", `dialect: "postgresql",\n  schemaFilter: ["${schema}"],`));
    // Normalization uses unqualified table names; exclude public from its path.
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const env = { ...process.env, DATABASE_URL: url.toString(), CI: "true" };
    const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
    function run(command, args, cwd, childEnv = env) {
      const result = spawnSync(command, args, {
        cwd, env: childEnv, encoding: "utf8", timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        .replaceAll(process.env.DATABASE_URL, "[database]")
        .replaceAll(url.toString(), "[isolated database]");
      assert.equal(result.error?.code, undefined, `${command} failed: ${result.error?.code}\n${output}`);
      assert.equal(result.status, 0, `${command} failed\n${output}`);
      return output;
    }
    // Only dependency installation is elided: existing node_modules are reused.
    // Every other pnpm call goes through the real workspace selector and DB script.
    const bin = path.join(fixture, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "pnpm"),
      '#!/bin/bash\nif [[ "$*" == "install --frozen-lockfile" ]]; then exit 0; fi\nexec "$REAL_PNPM" "$@"\n',
      { mode: 0o755 });
    const setupEnv = { ...env, REAL_PNPM: pnpm, PATH: `${bin}:${process.env.PATH}` };
    assert.equal((await client.query(
      "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = $1", [schema],
    )).rows[0].count, 0);
    // Production invocation must retain its strict missing-table failure.
    for (const productionEnv of [{ NODE_ENV: "production" }, { REPLIT_DEPLOYMENT: "1" }]) {
      const result = spawnSync(process.execPath, ["./scripts/normalize-subscriber-emails.mjs"], {
        cwd: fixtureDb, env: { ...env, ...productionEnv },
        encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /relation "subscribers" does not exist/);
    }
    const bootstrapOutput = run("bash", [path.join(root, "scripts/post-merge.sh")], fixture, setupEnv);
    assert.match(bootstrapOutput, /No subscriber tables yet/);
    const tables = (await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = $1", [schema],
    )).rows.map(row => row.tablename);
    for (const name of ["subscribers", "spotlight_notifications", "submissions"]) {
      assert.ok(tables.includes(name), `Setup must create ${name}\n${bootstrapOutput}`);
    }
    async function readIndexes() {
      return (await client.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = $1 AND tablename = 'subscribers'
           AND indexname = ANY($2::text[]) ORDER BY indexname`,
        [schema, indexes],
      )).rows;
    }
    const declared = await readIndexes();
    assert.deepEqual(declared.map(row => row.indexname), [...indexes].sort(),
      `Both backlog indexes must remain in the schema declarations\n${bootstrapOutput}`);
    for (const name of indexes) await client.query(`DROP INDEX "${schema}"."${name}"`);
    assert.deepEqual(await readIndexes(), [], "Fixture must start with both indexes missing");

    // Simulate legacy case/whitespace duplicates before the canonical index.
    await client.query(`DROP INDEX "${schema}".subscribers_email_idx`);
    await client.query(`
      INSERT INTO "${schema}".subscribers
        (email, unsubscribe_token_hash, verification_token_hash, verified_at)
      VALUES (' FirstTime@Example.com ', 'active', 'clear-me', now()),
             ('firsttime@example.com', 'pending', 'pending-token', null)
    `);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const output = run("bash", [path.join(root, "scripts/post-merge.sh")], fixture, setupEnv);
      assert.deepEqual(await readIndexes(), declared,
        `Setup run ${attempt} must restore/preserve both exact index definitions\n${output}`);
      assert.doesNotMatch(output, /No subscriber tables yet/);
      assert.deepEqual((await client.query(`
        SELECT email, unsubscribe_token_hash, verification_token_hash,
               verified_at IS NOT NULL AS verified
        FROM "${schema}".subscribers
      `)).rows, [{
        email: "firsttime@example.com", unsubscribe_token_hash: "active",
        verification_token_hash: null, verified: true,
      }], "Existing subscribers must still be normalized on every setup run");
      assert.equal((await client.query(`
        SELECT count(*)::int AS count FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'subscribers_email_idx'
      `, [schema])).rows[0].count, 1, "Canonical uniqueness must be restored after normalization");
    }
    // A missing neighbor is not an empty database and must not be ignored.
    await client.query(`DROP TABLE "${schema}".spotlight_notifications`);
    const partial = spawnSync(process.execPath, ["./scripts/normalize-subscriber-emails.mjs"], {
      cwd: fixtureDb, env, encoding: "utf8", timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ifError(partial.error);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /relation "spotlight_notifications" does not exist/);
  } finally {
    try {
      if (connected) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await client.end();
      await rm(fixture, { recursive: true, force: true });
    }
  }
});
