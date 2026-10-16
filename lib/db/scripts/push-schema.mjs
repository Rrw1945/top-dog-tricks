import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

// Development setup has no terminal. Never approve destructive changes here.
// drizzle-kit can catch a prompt/SQL error and nevertheless exit zero.
const result = spawnSync("drizzle-kit", ["push", "--config", "./drizzle.config.ts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
const output = stripVTControlCharacters(result.stdout ?? "");
const confirmed = /^\[(?:✓|i)\] (?:Changes applied|No changes detected)\s*$/m.test(output);
if (result.error || result.signal || result.status !== 0 || !confirmed) {
  console.error(
    "Development database schema push failed or did not confirm completion. " +
    "Setup stopped; review the Drizzle output above and resolve any required " +
    "schema/data-loss decisions manually. No destructive changes were automatically approved.",
  );
  if (result.error) console.error(`Could not run drizzle-kit: ${result.error.code}`);
  process.exitCode = result.status > 0 ? result.status : 1;
}
