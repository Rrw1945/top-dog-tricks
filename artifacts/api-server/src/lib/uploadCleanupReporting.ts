export interface CleanupHealth {
  totalRuns: number;
  failedRuns: number;
  failedObjects: number;
  consecutiveFailures: number;
  lastFinishedAt: Date | null;
  lastFailureAt: Date | null;
}

export function parseCleanupOptions(args: string[]) {
  let apply = false;
  let status = false;
  let threshold = 3;
  const seen = new Set<string>();
  for (const arg of args) {
    const key = arg.split("=")[0];
    if (seen.has(key)) throw new Error("Duplicate cleanup option");
    seen.add(key);
    if (arg === "--apply") apply = true;
    else if (arg === "--status") status = true;
    else if (/^--alert-after=[1-9][0-9]*$/.test(arg)) {
      threshold = Number(arg.split("=")[1]);
      if (!Number.isSafeInteger(threshold)) throw new Error("Invalid cleanup alert threshold");
    } else throw new Error("Usage: cleanup-entry-uploads [--apply | --status] [--alert-after=N]");
  }
  if (apply && status) throw new Error("Status cannot be combined with apply");
  return { apply, status, threshold };
}

// Explicit projection: never persist arbitrary keys supplied by a dependency.
const countKeys = ["excluded", "referenced", "missing", "changed_generation",
  "observed", "young", "eligible", "deleted", "failed", "storage_uncertain"] as const;
export function safeCleanupCounts(counts: Record<string, number>) {
  const result: Record<string, number> = {};
  for (const key of countKeys) {
    const value = counts[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid cleanup counts");
    result[key] = value;
  }
  return result;
}

interface ReportingDependencies {
  run(apply: boolean): Promise<Record<string, number>>;
  readFences(): Promise<number>;
  read(): Promise<CleanupHealth>;
  record(failed: boolean, failedObjects: number): Promise<CleanupHealth>;
  log(level: "info" | "warn" | "error", data: object, message: string): void;
}

export async function reportUploadCleanup(args: string[], deps: ReportingDependencies): Promise<number> {
  try {
    const options = parseCleanupOptions(args);
    // Verify durable reporting is available BEFORE allowing deletion.
    let health = await deps.read();
    let unresolvedDeletingFences = await deps.readFences();
    const validateFences = () => {
      if (!Number.isSafeInteger(unresolvedDeletingFences) || unresolvedDeletingFences < 0) {
        throw new Error("Invalid fence count");
      }
    };
    validateFences();
    let counts: Record<string, number> = {};
    let failed = false;
    let aborted = false;
    if (!options.status) {
      try {
        counts = safeCleanupCounts(await deps.run(options.apply));
        failed = (counts.failed ?? 0) > 0 || (counts.changed_generation ?? 0) > 0 ||
          (counts.storage_uncertain ?? 0) > 0;
      } catch {
        failed = true;
        aborted = true;
      }
      unresolvedDeletingFences = await deps.readFences();
      validateFences();
      if (options.apply) health = await deps.record(
        failed || unresolvedDeletingFences > 0, counts.failed ?? 0);
    }
    const alert = health.consecutiveFailures >= options.threshold;
    const attention = unresolvedDeletingFences > 0 || (counts.changed_generation ?? 0) > 0 ||
      (counts.storage_uncertain ?? 0) > 0;
    deps.log(alert || attention ? "warn" : failed ? "error" : "info", {
      event: alert || attention ? "entry_upload_cleanup_alert" : "entry_upload_cleanup_report",
      ...options, counts, health, aborted,
      attention: {
        required: attention,
        unresolvedDeletingFences,
        changedGenerationThisPass: counts.changed_generation ?? 0,
        uncertainOutcomeThisPass: counts.storage_uncertain ?? 0,
        guidance: attention
          ? "See docs/abandoned-entry-upload-cleanup.md#investigating-permanent-deletion-fences. Check registry state, stored generation and provider metadata/audit history using authorized operator access. Counts may include in-flight work. Never remove fences or overwrite generations to force a retry."
          : null,
      },
    }, attention ? "Entry upload cleanup has unresolved deletion fences; operator investigation required"
      : alert ? "Entry upload cleanup repeatedly failing; operator investigation required"
      : "Entry upload cleanup report");
    return failed || alert || attention ? 1 : 0;
  } catch {
    // Do not serialize thrown errors: drivers/providers can embed private paths,
    // SQL parameters, credentials, and entrant information.
    deps.log("error", { event: "entry_upload_cleanup_reporting_failed" },
      "Cleanup could not finish or report durable health; check options and database migration/connectivity");
    return 1;
  }
}
