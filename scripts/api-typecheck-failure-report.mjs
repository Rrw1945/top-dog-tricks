import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Deliberately project known diagnostic fields, never Error messages, stacks,
// owner records, or arbitrary attached properties.
function projectDiagnostic(record) {
  const location = (value) => ({
    ...(typeof value?.path === "string" ? { path: value.path } : {}),
    ...(typeof value?.remains === "boolean" ? { remains: value.remains } : {}),
  });
  return {
    schemaVersion: 1,
    ...(typeof record.phase === "string" ? { phase: record.phase } : {}),
    ...(typeof record.canonicalOutput === "string"
      ? { canonicalOutput: record.canonicalOutput } : {}),
    ...(typeof record.transition === "boolean" ? { transition: record.transition } : {}),
    ...(typeof record.ownerStatus === "string" ? { ownerStatus: record.ownerStatus } : {}),
    filesystemState: {
      lockDirectory: location(record.filesystemState?.lockDirectory),
      ownerFile: location(record.filesystemState?.ownerFile),
    },
  };
}

export function createFailureReport(error) {
  const visited = new Set();
  const records = new Set();
  const lockDiagnostics = [];
  function add(record) {
    if (!record || typeof record !== "object" || records.has(record)) return;
    records.add(record);
    lockDiagnostics.push(projectDiagnostic(record));
  }
  function visit(value) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    add(value.lockDiagnostic);
    if (Array.isArray(value.lockDiagnostics)) value.lockDiagnostics.forEach(add);
    if (Array.isArray(value.errors)) value.errors.forEach(visit);
    visit(value.cause);
  }
  visit(error);
  return { schemaVersion: 1, status: "failed", lockDiagnostics };
}

export function installFailureReport(argv = process.argv.slice(2)) {
  const options = argv.filter((arg) =>
    arg === "--failure-report" || arg.startsWith("--failure-report="));
  if (!options.length) return;
  const option = options[0];
  const destination = option === "--failure-report"
    ? argv[argv.indexOf(option) + 1]
    : option.slice("--failure-report=".length);
  if (options.length !== 1 || !destination || destination.startsWith("--")) {
    throw new Error("Use --failure-report <file.json> exactly once with a nonempty path");
  }
  const reportPath = path.resolve(destination);
  // Monitor, rather than handle, uncaught failures so Node retains its normal
  // stderr rendering and nonzero exit. Synchronous I/O is required at this point.
  process.on("uncaughtExceptionMonitor", (error) => {
    const temporaryPath = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const contents = `${JSON.stringify(createFailureReport(error), null, 2)}\n`;
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(temporaryPath, contents, { flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, reportPath);
    } catch {
      // Do not echo filesystem errors: they can contain arbitrary private data.
      console.error("[failure report] Could not write JSON report; original failure follows.");
    } finally {
      try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    }
  });
}
