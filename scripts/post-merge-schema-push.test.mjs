import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();

// Run the real normalizer CLI and package chain with only pg replaced. These
// errors must never be mistaken for the legitimate "both tables absent" case.
for (const scenario of [
  {
    name: "failed table-existence lookup",
    stage: "lookup",
    message: "permission denied for schema public",
    code: "42501",
    queries: ["lookup"],
  },
  {
    name: "insufficient table privileges",
    stage: "lock",
    message: "permission denied for table subscribers",
    code: "42501",
    queries: ["lookup", "begin", "lock", "rollback"],
  },
]) {
  test(`database access failure stops setup: ${scenario.name}`, { timeout: 60_000 }, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "setup-db-access-"));
    try {
      const db = path.join(fixture, "lib/db");
      const bin = path.join(fixture, "bin");
      const fakePg = path.join(db, "node_modules/pg");
      await mkdir(path.join(db, "scripts"), { recursive: true });
      await mkdir(fakePg, { recursive: true });
      await mkdir(bin);
      await writeFile(path.join(fixture, "package.json"), '{"private":true}');
      await writeFile(path.join(fixture, "pnpm-workspace.yaml"), "packages:\n  - lib/db\n");
      await cp(path.join(root, "lib/db/package.json"), path.join(db, "package.json"));
      await cp(path.join(root, "lib/db/scripts/normalize-subscriber-emails.mjs"),
        path.join(db, "scripts/normalize-subscriber-emails.mjs"));
      await writeFile(path.join(fakePg, "package.json"),
        '{"name":"pg","type":"module","exports":"./index.mjs"}');
      await writeFile(path.join(fakePg, "index.mjs"), `
import { appendFileSync } from "node:fs";
const record = (event) => appendFileSync(process.env.TRACE, event + "\\n");
export default {
  Pool: class {
    async connect() {
      record("connect");
      return {
        async query(sql) {
          const stage = sql.includes("to_regclass") ? "lookup"
            : sql.includes("lock table") ? "lock" : sql.trim();
          record(stage);
          if (stage === process.env.FAIL_STAGE) {
            throw Object.assign(new Error(process.env.FAIL_MESSAGE), {
              code: process.env.FAIL_CODE,
              severity: "ERROR",
            });
          }
          if (stage === "lookup") {
            return { rows: [{ subscribers: "subscribers", notifications: "spotlight_notifications" }] };
          }
          if (stage !== "begin" && stage !== "rollback") {
            throw new Error("Unexpected query after access failure");
          }
          return { rows: [] };
        },
        release() { record("release"); },
      };
    }
    async end() { record("end"); }
  },
};
`);
      // Sentinels detect any attempt to continue, including the shell's separate
      // migrate:upload-cleanup command after the package's push chain.
      for (const script of [
        "prepare-review-search", "push-schema",
        "migrate-submission-publication", "install-upload-cleanup",
      ]) {
        await writeFile(path.join(db, `scripts/${script}.mjs`),
          `import { appendFileSync } from "node:fs"; appendFileSync(process.env.TRACE, ${JSON.stringify(script + "\n")});`);
      }
      await writeFile(path.join(bin, "pnpm"),
        '#!/bin/bash\nif [[ "$*" == "install --frozen-lockfile" ]]; then exit 0; fi\nexec "$REAL_PNPM" "$@"\n',
        { mode: 0o755 });
      // Synthetic credentials only: no actual database or privileged role needed.
      const username = "setup_private_user";
      const password = "setup_private_password";
      const connectionString = `postgresql://${username}:${password}@private-db.invalid:5432/fixture`;
      for (const entrypoint of ["cli", "post-merge"]) {
        const trace = path.join(fixture, `${entrypoint}-trace`);
        const result = spawnSync(
          entrypoint === "cli" ? process.execPath : "bash",
          [entrypoint === "cli"
            ? path.join(db, "scripts/normalize-subscriber-emails.mjs")
            : path.join(root, "scripts/post-merge.sh")],
          {
            cwd: fixture,
            env: {
              ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_PNPM: pnpm,
              NODE_ENV: "development", REPLIT_DEPLOYMENT: "0",
              DATABASE_URL: connectionString, TRACE: trace,
              FAIL_STAGE: scenario.stage, FAIL_MESSAGE: scenario.message,
              FAIL_CODE: scenario.code,
            },
            encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 25_000,
          },
        );
        assert.ifError(result.error);
        assert.equal(result.signal, null, `${entrypoint} must exit normally, not time out`);
        assert.ok(Number.isInteger(result.status) && result.status > 0,
          `${entrypoint} must fail on database access errors`);
        const output = `${result.stdout}\n${result.stderr}`;
        assert.ok(output.includes(scenario.message), `${entrypoint} must retain the database diagnostic`);
        assert.ok(output.includes(scenario.code), `${entrypoint} must retain the PostgreSQL error code`);
        assert.doesNotMatch(output, /No subscriber tables yet|development schema setup will create them/);
        for (const secret of [connectionString, username, password]) {
          assert.ok(!output.includes(secret), `${entrypoint} must not expose connection credentials`);
        }
        assert.deepEqual((await readFile(trace, "utf8")).trim().split("\n"),
          ["connect", ...scenario.queries, "release", "end"],
          `${entrypoint} must release the connection and stop before any later setup step`);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

// Exercise the real post-merge shell and package push chain without touching a DB.
for (const scenario of [
  { name: "noninteractive prompt error with zero exit", output: "Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false).", ok: false },
  { name: "SQL error with zero exit", output: "error: relation does not exist", ok: false },
  { name: "aborted changes with zero exit", output: "[x] All changes were aborted", ok: false },
  { name: "no completion evidence", output: "Pulling schema from database...", ok: false },
  { name: "nonzero exit even with completion text", output: "[✓] Changes applied", status: 7, ok: false },
  { name: "applied changes", output: "[\u001b[32m✓\u001b[0m] Changes applied", ok: true },
  { name: "unchanged schema", output: "[i] No changes detected", ok: true },
]) {
  test(`post-merge handles ${scenario.name}`, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "schema-push-"));
    try {
      const db = path.join(fixture, "lib/db");
      const bin = path.join(fixture, "bin");
      await mkdir(path.join(db, "scripts"), { recursive: true });
      await mkdir(bin);
      await writeFile(path.join(fixture, "package.json"), '{"private":true}');
      await writeFile(path.join(fixture, "pnpm-workspace.yaml"), "packages:\n  - lib/db\n");
      await cp(path.join(root, "lib/db/package.json"), path.join(db, "package.json"));
      await cp(path.join(root, "lib/db/scripts/push-schema.mjs"), path.join(db, "scripts/push-schema.mjs"));
      const trace = path.join(fixture, "trace");
      for (const script of [
        "normalize-subscriber-emails", "prepare-review-search",
        "migrate-submission-publication", "install-upload-cleanup",
      ]) {
        await writeFile(path.join(db, `scripts/${script}.mjs`),
          `import { appendFileSync } from "node:fs"; appendFileSync(process.env.TRACE, ${JSON.stringify(script + "\n")});`);
      }
      await writeFile(path.join(bin, "pnpm"),
        '#!/bin/bash\nif [[ "$*" == "install --frozen-lockfile" ]]; then exit 0; fi\nexec "$REAL_PNPM" "$@"\n',
        { mode: 0o755 });
      await writeFile(path.join(bin, "drizzle-kit"),
        '#!/bin/bash\nprintf "drizzle %s\\n" "$*" >> "$TRACE"\nprintf "%s\\n" "$DRIZZLE_OUTPUT"\nexit "$DRIZZLE_STATUS"\n',
        { mode: 0o755 });
      const result = spawnSync("bash", [path.join(root, "scripts/post-merge.sh")], {
        cwd: fixture,
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_PNPM: pnpm,
          TRACE: trace, DRIZZLE_OUTPUT: scenario.output,
          DRIZZLE_STATUS: String(scenario.status ?? 0),
        },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
      });
      assert.ifError(result.error);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status === 0, scenario.ok, output);
      assert.ok(output.includes(scenario.output), "original diagnostics must be preserved");
      const steps = (await readFile(trace, "utf8")).trim().split("\n");
      assert.deepEqual(steps, [
        "normalize-subscriber-emails", "prepare-review-search",
        "drizzle push --config ./drizzle.config.ts",
        ...(scenario.ok ? ["migrate-submission-publication", "install-upload-cleanup", "install-upload-cleanup"] : []),
      ]);
      if (!scenario.ok) assert.match(output, /Setup stopped.*manually/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
