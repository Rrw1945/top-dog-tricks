import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSubscriberTestDatabase,
  setupSubscriberTestSchema,
} from "./setup-subscriber-test-schema.mjs";

const env = { DATABASE_URL: "postgres://localhost/subscriber_notifications" };

test("schema fixture rejects non-disposable database targets before executing DDL", () => {
  assert.doesNotThrow(() => assertSubscriberTestDatabase(env));
  for (const override of [
    { DATABASE_URL: "postgres://remote/subscriber_notifications" },
    { DATABASE_URL: "postgres://localhost/application" },
    { DATABASE_URL: `${env.DATABASE_URL}?options=-csearch_path=other` },
    { NODE_ENV: "production" },
    { REPLIT_DEPLOYMENT: "1" },
  ]) {
    assert.throws(() => assertSubscriberTestDatabase({ ...env, ...override }));
  }
});

function fixture({ failedScript, missingTable, missingExtension, missingIndexes } = {}) {
  const calls = [];
  let ended = false;
  return {
    calls,
    get ended() { return ended; },
    options: {
      env,
      run(_command, [script]) {
        calls.push(script);
        return { status: script === failedScript ? 1 : 0 };
      },
      client: {
        async connect() { calls.push("connect"); },
        async end() { ended = true; },
        async query(sql) {
          if (sql.includes("CROSS JOIN")) {
            if (missingTable) throw new Error("missing subscriber table");
            return { rows: [] };
          }
          if (sql.includes("pg_opclass")) return { rows: missingExtension ? [] : [{}] };
          return { rows: missingIndexes ? [] : [{}, {}] };
        },
      },
    },
  };
}

test("extension preparation precedes guarded push and actual schema verification", async () => {
  const f = fixture();
  await setupSubscriberTestSchema(f.options);
  assert.deepEqual(f.calls, ["scripts/prepare-review-search.mjs", "scripts/push-schema.mjs", "connect"]);
  assert.equal(f.ended, true);
});

test("preparation and push failures stop setup instead of running subscribers", async () => {
  for (const script of ["prepare-review-search.mjs", "push-schema.mjs"]) {
    const f = fixture({ failedScript: `scripts/${script}` });
    await assert.rejects(setupSubscriberTestSchema(f.options), /setup failed/);
    assert.equal(f.calls.includes("connect"), false);
    assert.equal(f.calls.at(-1), `scripts/${script}`);
  }
});

test("zero-exit setup cannot hide absent tables, extension, or uniqueness indexes", async () => {
  for (const key of ["missingTable", "missingExtension", "missingIndexes"]) {
    const f = fixture({ [key]: true });
    await assert.rejects(setupSubscriberTestSchema(f.options));
    assert.equal(f.ended, true);
  }
});
