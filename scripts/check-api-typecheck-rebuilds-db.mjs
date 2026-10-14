import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { installFailureReport } from "./api-typecheck-failure-report.mjs";

installFailureReport();

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectValidationFailure = process.argv.includes(
  "--expect-validation-failure",
);
const testConcurrentRuns = process.argv.includes("--test-concurrent-runs");
const testInterruptedRecovery = process.argv.includes(
  "--test-interrupted-recovery",
);
const testInterruptedPublication = process.argv.includes(
  "--test-interrupted-publication",
);
const testRecoveryLockHandoff = process.argv.includes(
  "--test-recovery-lock-handoff",
);
const testRecoveryLockCleanup = process.argv.includes(
  "--test-recovery-lock-cleanup",
);
const testRecoveryLockRescanFailure = process.argv.includes(
  "--test-recovery-lock-rescan-failure",
);
const testRecoveryLockMultiRescanFailure = process.argv.includes(
  "--test-recovery-lock-multi-rescan-failure",
);
const runRecoveryLockHandoffFixture = process.argv.includes(
  "--run-recovery-lock-handoff-fixture",
);
const runRecoveryLockRescanFailureFixture = process.argv.includes(
  "--run-recovery-lock-rescan-failure-fixture",
);
const runRecoveryLockMultiRescanFailureFixture = process.argv.includes(
  "--run-recovery-lock-multi-rescan-failure-fixture",
);
const runTransitionLockOwnerFixture = process.argv.includes(
  "--run-transition-lock-owner-fixture",
);
const runTransitionLockOwnerReplacementFixture = process.argv.includes(
  "--run-transition-lock-owner-replacement-fixture",
);
const runInterruptedPublicationFixture = process.argv.includes(
  "--run-interrupted-publication-fixture",
);
const runInterruptedPublicationRecovery = process.argv.includes(
  "--run-interrupted-publication-recovery",
);
const testProcessIdentity = process.argv.includes("--test-process-identity");
const testNativeProcessIdentity = process.argv.includes(
  "--test-native-process-identity",
);
const testNativeTransitionLockOwnerExitProbe = process.argv.includes(
  "--test-native-transition-lock-owner-exit",
);
const runNativeTransitionInterruptionFixture = process.argv.includes(
  "--run-native-transition-interruption-fixture",
);
const testNativeProcessIdentityTimeout = process.argv.includes(
  "--test-native-process-identity-timeout",
);
const testNativeProcessIdentityDescendantLifecycle = process.argv.includes(
  "--test-native-process-identity-descendant-lifecycle",
);
const testNativeProcessIdentityRecovery = process.argv.includes(
  "--test-native-process-identity-recovery",
);
const testUnsafeRecoveryManifests =
  process.argv.includes("--test-unsafe-recovery-manifests") ||
  testNativeProcessIdentityRecovery;
const testRecoveryOwnerAge = process.argv.includes("--test-recovery-owner-age");
const runValidationChild = process.argv.includes("--run-validation-child");
const collectNativeProcessDiagnostics = process.argv.includes(
  "--collect-native-process-diagnostics",
);
const recordNativeProcessProbeFailure = process.argv.includes(
  "--record-native-process-probe-failure",
);
const verifyNativeProcessRecoveryDiagnostics = process.argv.includes(
  "--verify-native-process-recovery-diagnostics",
);
const testNativeRecoveryDiagnosticAtomicity = process.argv.includes(
  "--test-native-recovery-diagnostic-atomicity",
);
const runNativeRecoveryDiagnosticInterruptionFixture = process.argv.includes(
  "--run-native-recovery-diagnostic-interruption-fixture",
);
const nativeDiagnosticsDirectory =
  process.env.API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR ??
  path.join(os.tmpdir(), "api-typecheck-native-process-diagnostics");
const nativeProcessRecoveryFailureLabel = "pid-reuse-recovery-batch";
const nativeProcessRecoverySchemaVersion = 1;
const nativeProcessRecoveryDiagnosticsFileName =
  "pid-reuse-recovery-batch.json";
const lockStaleAfterMs = Number(
  process.env.API_TYPECHECK_LOCK_STALE_AFTER_MS ?? 30 * 60 * 1000,
);
const lockWaitTimeoutMs = Number(
  process.env.API_TYPECHECK_LOCK_WAIT_TIMEOUT_MS ?? 10 * 60 * 1000,
);
const processIdentityCommandTimeoutMs = 5_000;
const unavailableProcessIdentityPids = new Set();
const invalidProcessIdentityValues = [
  0, 42, false, true, {}, [], ["456789"], "", "   ", "\t\n",
];
let recoveryCleanupFailureInjected = false;
let recoveryCleanupReleaseFailureInjected = false;
let recoveryCleanupReleaseFailurePath = null;
let recoveryCleanupTransitionReleaseFailureInjected = false;
let recoveryCleanupTransitionReleaseFailurePath = null;
let recoveryCleanupBeforeRemovalError = null;
const multiRescanOutputReleaseFailures = new Set();
const multiRescanTransitionReleaseFailures = new Set();
const multiRescanReleasedOutputs = new Set();

const nativeDiagnosticsEnvironmentKeys = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_JOB",
  "GITHUB_REF_NAME",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_WORKFLOW",
  "ImageOS",
  "ImageVersion",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "RUNNER_NAME",
];
const nativeProcessProbePhases = new Set([
  "identity",
  "filesystem-setup",
  "transition-locking",
  "filesystem-cleanup",
]);

async function exposeNativeProcessProbePhase(phase) {
  if (!nativeProcessProbePhases.has(phase)) {
    throw new Error("Native process probe phase must be a recognized safe label");
  }
  const githubOutputFile = process.env.GITHUB_OUTPUT;
  if (githubOutputFile) {
    await writeFile(
      githubOutputFile,
      `phase=${phase}\n`,
      { flag: "a" },
    );
  }
}

function runNativeDiagnosticsCommand(command, args = []) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: 1_000_000,
      timeout: 10_000,
      windowsHide: true,
    });
    return [
      `status=${result.status ?? "null"}`,
      `signal=${result.signal ?? "null"}`,
      result.error ? `error=${result.error.message}` : "",
      result.stdout ?? "",
      result.stderr ?? "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    return `error=${error instanceof Error ? error.message : String(error)}`;
  }
}

async function recordNativeProcessRecoveryDiagnostics({
  affectedTransactions,
  error,
}) {
  const diagnosticsFile =
    process.env.API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE ??
    (process.env.API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR
      ? path.join(
          nativeDiagnosticsDirectory,
          nativeProcessRecoveryDiagnosticsFileName,
        )
      : null);
  if (!diagnosticsFile) {
    return;
  }

  try {
    await mkdir(path.dirname(diagnosticsFile), { recursive: true });
    await writeNativeRecoveryDiagnosticAtomically(
      diagnosticsFile,
      `${JSON.stringify(
        {
          schemaVersion: nativeProcessRecoverySchemaVersion,
          failureLabel: nativeProcessRecoveryFailureLabel,
          error: error instanceof Error ? error.message : String(error),
          host: {
            name:
              process.env.API_TYPECHECK_NATIVE_TEST_HOST ?? process.platform,
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
          },
          runtime: {
            execPath: process.execPath,
            version: process.version,
            versions: process.versions,
          },
          affectedTransactions: affectedTransactions.map(
            ({ transactionDirectory, source }) => ({
              directory: transactionDirectory,
              paths: [source],
            }),
          ),
        },
        null,
        2,
      )}\n`,
    );
  } catch (diagnosticError) {
    console.error(
      `[native diagnostics] Could not write ${diagnosticsFile}: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`,
    );
  }
}

async function writeNativeRecoveryDiagnosticAtomically(
  diagnosticsFile,
  contents,
  {
    writeTemporaryFile = (temporaryFile, temporaryContents) =>
      writeFile(temporaryFile, temporaryContents, { flag: "wx" }),
  } = {},
) {
  const temporaryFile = path.join(
    path.dirname(diagnosticsFile),
    `.${path.basename(diagnosticsFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeTemporaryFile(temporaryFile, contents);
    await rename(temporaryFile, diagnosticsFile);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}

async function collectNativeProcessDiagnosticsBundle({
  diagnosticsDirectory = nativeDiagnosticsDirectory,
  removeTemporaryFile = rm,
  ...publicationOptions
} = {}) {
  try {
    await mkdir(diagnosticsDirectory, { recursive: true });
  } catch (error) {
    console.error(
      `[native diagnostics] Could not create ${diagnosticsDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // The workflow invokes collection only after the probe has exited. Match only
  // the atomic publisher's recovery-record staging files, never generic *.tmp.
  try {
    const entries = await readdir(diagnosticsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        /^\.pid-reuse-recovery-batch\.json\.[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(entry.name)
      ) {
        await removeTemporaryFile(path.join(diagnosticsDirectory, entry.name), { force: true })
          .catch((error) => {
            console.error(`[native diagnostics] Could not remove abandoned recovery temporary file ${entry.name}: ${error.message}`);
          });
      }
    }
  } catch (error) {
    console.error(`[native diagnostics] Could not inspect recovery temporary files: ${error.message}`);
  }

  const writeDiagnostic = async (fileName, contents) => {
    try {
      await writeNativeRecoveryDiagnosticAtomically(
        path.join(diagnosticsDirectory, fileName),
        contents,
        publicationOptions,
      );
    } catch (error) {
      console.error(
        `[native diagnostics] Could not write ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const runnerContext = Object.fromEntries(
    nativeDiagnosticsEnvironmentKeys
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  await writeDiagnostic(
    "probe-attribution.json",
    `${JSON.stringify(
      {
        failedStep: process.env.API_TYPECHECK_NATIVE_PROBE_FAILURE ?? "unknown",
        failedPhase: process.env.API_TYPECHECK_NATIVE_PROBE_PHASE ?? "unknown",
      },
      null,
      2,
    )}\n`,
  );
  await writeDiagnostic(
    "runner-context.json",
    `${JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        node: {
          execPath: process.execPath,
          version: process.version,
          versions: process.versions,
        },
        runner: runnerContext,
      },
      null,
      2,
    )}\n`,
  );

  await writeDiagnostic(
    "node-runtime.txt",
    runNativeDiagnosticsCommand(process.execPath, [
      "-p",
      "JSON.stringify({execPath: process.execPath, version: process.version, versions: process.versions, platform: process.platform, arch: process.arch, release: process.release})",
    ]) + "\n",
  );
  await writeDiagnostic(
    "package-manager.txt",
    runNativeDiagnosticsCommand("pnpm", ["--version"]) + "\n",
  );

  const hostCommands =
    process.platform === "win32"
      ? [
          {
            fileName: "host-version.txt",
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$os = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ Caption = $os.Caption; Version = $os.Version; BuildNumber = $os.BuildNumber; Architecture = $os.OSArchitecture } | Format-List",
            ],
          },
          {
            fileName: "process-tree.txt",
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate | Sort-Object ProcessId | Format-Table -AutoSize | Out-String -Width 240",
            ],
          },
        ]
      : [
          {
            fileName: "host-version.txt",
            command: process.platform === "darwin" ? "sw_vers" : "uname",
            args: process.platform === "darwin" ? [] : ["-a"],
          },
          {
            fileName: "process-tree.txt",
            command: "ps",
            args: ["-axo", "pid=,ppid=,user=,state=,lstart=,comm="],
          },
        ];
  for (const { fileName, command, args } of hostCommands) {
    await writeDiagnostic(
      fileName,
      runNativeDiagnosticsCommand(command, args) + "\n",
    );
  }
}

async function recordNativeProcessProbeFailureForDiagnostics() {
  const githubEnvironmentFile = process.env.GITHUB_ENV;
  const failedProbe = process.env.API_TYPECHECK_NATIVE_PROBE_FAILURE;
  const failedPhase =
    failedProbe === "stale-lock-takeover"
      ? process.env.API_TYPECHECK_NATIVE_PROBE_PHASE
      : "not-applicable";
  if (!githubEnvironmentFile) {
    throw new Error(
      "Native process probe attribution requires the GitHub Actions environment file",
    );
  }
  if (!/^[a-z0-9-]+$/.test(failedProbe ?? "")) {
    throw new Error("Native process probe attribution must be a safe label");
  }
  if (
    failedPhase !== "not-applicable" &&
    !nativeProcessProbePhases.has(failedPhase)
  ) {
    throw new Error("Native process probe phase must be a recognized safe label");
  }

  await writeFile(
    githubEnvironmentFile,
    `API_TYPECHECK_NATIVE_PROBE_FAILURE=${failedProbe}\nAPI_TYPECHECK_NATIVE_PROBE_PHASE=${failedPhase}\n`,
    { flag: "a" },
  );
}

async function verifyNativeProcessRecoveryDiagnosticsRecord() {
  const diagnosticsFile =
    process.env.API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE;
  if (!diagnosticsFile) {
    throw new Error(
      "PID-reuse recovery record validation requires API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE",
    );
  }

  let contents;
  try {
    contents = await readFile(diagnosticsFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Missing PID-reuse recovery record at ${diagnosticsFile}; the recovery probe must write pid-reuse-recovery-batch.json when it rejects a batch`,
      );
    }
    throw new Error(
      `Could not read PID-reuse recovery record at ${diagnosticsFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let diagnostic;
  try {
    diagnostic = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `PID-reuse recovery record at ${diagnosticsFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const isRecord = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const problems = [];
  if (!isRecord(diagnostic)) {
    problems.push("record must be a JSON object");
  } else {
    if (diagnostic.schemaVersion !== nativeProcessRecoverySchemaVersion) {
      const versionProblem = Object.hasOwn(diagnostic, "schemaVersion")
        ? `Unsupported schemaVersion ${JSON.stringify(diagnostic.schemaVersion)}`
        : "Missing schemaVersion";
      throw new Error(
        `${versionProblem} in PID-reuse recovery record at ${diagnosticsFile}; supported schemaVersion is ${nativeProcessRecoverySchemaVersion}. Regenerate the record with the recovery probe from the same revision as this validator, or update the validator to support the producer's format.`,
      );
    }
    if (diagnostic.failureLabel !== nativeProcessRecoveryFailureLabel) {
      problems.push(
        `failureLabel must be "${nativeProcessRecoveryFailureLabel}"`,
      );
    }
    if (typeof diagnostic.error !== "string" || !diagnostic.error.trim()) {
      problems.push("error must be a non-empty string");
    }

    if (!isRecord(diagnostic.host)) {
      problems.push("host metadata must be an object");
    } else {
      const expectedHostMetadata = {
        name: process.env.API_TYPECHECK_NATIVE_TEST_HOST ?? process.platform,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
      };
      for (const [field, expectedValue] of Object.entries(
        expectedHostMetadata,
      )) {
        if (
          typeof diagnostic.host[field] !== "string" ||
          !diagnostic.host[field].trim()
        ) {
          problems.push(`host.${field} must be a non-empty string`);
        } else if (diagnostic.host[field] !== expectedValue) {
          problems.push(`host.${field} does not match the current runner`);
        }
      }
    }

    if (
      !Array.isArray(diagnostic.affectedTransactions) ||
      diagnostic.affectedTransactions.length === 0
    ) {
      problems.push(
        "affectedTransactions must contain at least one transaction",
      );
    } else {
      diagnostic.affectedTransactions.forEach((transaction, index) => {
        const label = `affectedTransactions[${index}]`;
        if (!isRecord(transaction)) {
          problems.push(`${label} must be an object`);
          return;
        }
        if (
          typeof transaction.directory !== "string" ||
          !path.isAbsolute(transaction.directory)
        ) {
          problems.push(`${label}.directory must be an absolute path`);
        }
        if (
          !Array.isArray(transaction.paths) ||
          transaction.paths.length === 0 ||
          transaction.paths.some(
            (transactionPath) =>
              typeof transactionPath !== "string" ||
              !path.isAbsolute(transactionPath),
          )
        ) {
          problems.push(`${label}.paths must contain absolute paths`);
        }
      });
    }

    if (!isRecord(diagnostic.runtime)) {
      problems.push("runtime metadata must be an object");
    } else {
      if (
        typeof diagnostic.runtime.execPath !== "string" ||
        !path.isAbsolute(diagnostic.runtime.execPath)
      ) {
        problems.push("runtime.execPath must be an absolute path");
      } else if (diagnostic.runtime.execPath !== process.execPath) {
        problems.push(
          "runtime.execPath does not match the current Node.js process",
        );
      }
      if (
        typeof diagnostic.runtime.version !== "string" ||
        !/^v\d+\.\d+\.\d+/.test(diagnostic.runtime.version)
      ) {
        problems.push("runtime.version must contain the Node.js version");
      } else if (diagnostic.runtime.version !== process.version) {
        problems.push(
          "runtime.version does not match the current Node.js process",
        );
      }
      if (
        !isRecord(diagnostic.runtime.versions) ||
        typeof diagnostic.runtime.versions.node !== "string" ||
        !/^\d+\.\d+\.\d+/.test(diagnostic.runtime.versions.node)
      ) {
        problems.push(
          "runtime.versions.node must contain the Node.js runtime version",
        );
      } else if (diagnostic.runtime.versions.node !== process.versions.node) {
        problems.push(
          "runtime.versions.node does not match the current Node.js process",
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Incomplete PID-reuse recovery record at ${diagnosticsFile}: ${problems.join("; ")}`,
    );
  }

  console.log(
    `Validated PID-reuse recovery record at ${diagnosticsFile} for ${diagnostic.affectedTransactions.length} affected transaction(s).`,
  );
}

if (collectNativeProcessDiagnostics) {
  await collectNativeProcessDiagnosticsBundle();
  process.exit(0);
}

if (verifyNativeProcessRecoveryDiagnostics) {
  await verifyNativeProcessRecoveryDiagnosticsRecord();
  process.exit(0);
}

if (recordNativeProcessProbeFailure) {
  await recordNativeProcessProbeFailureForDiagnostics();
  process.exit(0);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readLockOwnerRecord(ownerPath, readOwner = readJson) {
  try {
    const owner = await readOwner(ownerPath);
    if (owner === null) {
      throw Object.assign(new TypeError("JSON null is not a lock owner record"), {
        code: "ERR_NULL_LOCK_OWNER",
      });
    }
    return { owner, error: null };
  } catch (error) {
    return { owner: null, error };
  }
}

const apiDirectory = path.join(workspaceRoot, "artifacts", "api-server");
const failureFixture = path.join(
  apiDirectory,
  "src",
  "api-typecheck-regression-failure.ts",
);
const apiTsconfig = await readJson(path.join(apiDirectory, "tsconfig.json"));
async function loadDeclarationLibraries(configDirectory, references) {
  const libraries = await Promise.all(
    references.map(async ({ path: referencePath }) => {
      const directory = path.resolve(configDirectory, referencePath);
      const tsconfig = await readJson(path.join(directory, "tsconfig.json"));
      const compilerOptions = tsconfig.compilerOptions ?? {};

      if (!compilerOptions.composite || !compilerOptions.emitDeclarationOnly) {
        return null;
      }

      const packageJson = await readJson(path.join(directory, "package.json"));
      return {
        name: packageJson.name ?? path.relative(workspaceRoot, directory),
        directory,
        generatedPaths: [
          compilerOptions.outDir ?? "dist",
          compilerOptions.tsBuildInfoFile ?? "tsconfig.tsbuildinfo",
        ],
        declarationDirectory: compilerOptions.outDir ?? "dist",
      };
    }),
  );

  return libraries.filter(Boolean);
}

const declarationLibraries = await loadDeclarationLibraries(
  apiDirectory,
  apiTsconfig.references ?? [],
);
const rootTsconfig = await readJson(path.join(workspaceRoot, "tsconfig.json"));
const rootDeclarationLibraries = await loadDeclarationLibraries(
  workspaceRoot,
  rootTsconfig.references ?? [],
);
const generatedLibraries = [
  ...new Map(
    [...rootDeclarationLibraries, ...declarationLibraries].map((library) => [
      library.directory,
      library,
    ]),
  ).values(),
];

if (declarationLibraries.length === 0) {
  throw new Error(
    "API tsconfig does not reference any declaration-producing libraries",
  );
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readGeneratedFileMetadata(filePath) {
  const fileStats = await stat(filePath);
  return {
    mode: fileStats.mode,
    mtimeMs: fileStats.mtimeMs,
  };
}

async function readGeneratedTreeMetadata(root) {
  const entries = [];
  async function visit(relativePath) {
    const currentPath = path.join(root, relativePath);
    const stats = await stat(currentPath);
    entries.push({
      relativePath,
      kind: stats.isDirectory() ? "directory" : "file",
      ...await readGeneratedFileMetadata(currentPath),
    });
    if (stats.isDirectory()) {
      for (const child of (await readdir(currentPath)).sort()) {
        await visit(path.join(relativePath, child));
      }
    }
  }
  await visit(".");
  return entries;
}

async function createNestedPublicationOutput(root, partial = false) {
  await mkdir(path.join(root, "nested", "deeper"), { recursive: true });
  await mkdir(path.join(root, "empty"));
  const files = ["index.d.ts", "nested/types.d.ts", "nested/deeper/model.d.ts"];
  if (partial) {
    // A merge-style restore must not leave validation-only output behind.
    await mkdir(path.join(root, "partial-only"));
    files.push("partial-only/stale.d.ts", "nested/deeper/stale.d.ts");
  }
  for (const relativePath of files) {
    await writeFile(
      path.join(root, relativePath),
      `${partial ? "partial" : "original"} ${relativePath}\n`,
      { flag: "wx" },
    );
  }
  // Apply directory timestamps last: adding children changes their parents.
  const paths = [
    ...files,
    ...(partial ? ["partial-only"] : []),
    "nested/deeper", "nested", "empty", ".",
  ];
  for (const [index, relativePath] of paths.entries()) {
    const currentPath = path.join(root, relativePath);
    const isDirectory = (await stat(currentPath)).isDirectory();
    await chmod(currentPath, partial ? (isDirectory ? 0o700 : 0o600) :
      (isDirectory ? 0o750 : 0o640));
    const time = new Date(Date.UTC(partial ? 2020 : 2001, 1, 3, 4, 5, index));
    await utimes(currentPath, time, time);
  }
}

async function fingerprint(filePath) {
  if (!(await exists(filePath))) {
    return null;
  }

  const entries = [];
  async function visit(currentPath, relativePath) {
    const stats = await lstat(currentPath);
    if (stats.isDirectory()) {
      entries.push(`directory:${relativePath}`);
      const children = await readdir(currentPath);
      children.sort();
      for (const child of children) {
        await visit(
          path.join(currentPath, child),
          path.join(relativePath, child),
        );
      }
      return;
    }

    const contents = await readFile(currentPath);
    entries.push(
      `file:${relativePath}:${createHash("sha256").update(contents).digest("hex")}`,
    );
  }

  await visit(filePath, ".");
  return entries;
}

async function canonicalizePath(source) {
  const missingSegments = [];
  let existingAncestor = source;
  while (true) {
    try {
      return path.join(await realpath(existingAncestor), ...missingSegments);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        return source;
      }
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

const configuredLockedPaths = generatedLibraries
  .flatMap((library) =>
    library.generatedPaths.map((generatedPath) =>
      path.resolve(library.directory, generatedPath),
    ),
  )
  .concat(
    (process.env.API_TYPECHECK_EXTRA_GENERATED_PATHS ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((generatedPath) => path.resolve(workspaceRoot, generatedPath)),
  )
  .sort();
const lockedPaths = (
  process.env.API_TYPECHECK_TEST_GENERATED_PATHS
    ? process.env.API_TYPECHECK_TEST_GENERATED_PATHS.split(path.delimiter)
        .filter(Boolean)
        .map((generatedPath) => path.resolve(workspaceRoot, generatedPath))
    : configuredLockedPaths
).sort();
const canonicalLockedPaths = [
  ...new Set(await Promise.all(lockedPaths.map(canonicalizePath))),
].sort();
const lockKey = createHash("sha256")
  .update(canonicalLockedPaths.join("\0"))
  .digest("hex")
  .slice(0, 16);

if (runValidationChild) {
  const goPath = process.env.API_TYPECHECK_VALIDATION_GO_PATH;
  if (!goPath) {
    throw new Error("Validation child requires a go path");
  }
  while (!(await exists(goPath))) {
    if (process.ppid === 1) {
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const testValidationDelayMs = Number(
    process.env.API_TYPECHECK_TEST_VALIDATION_DELAY_MS ?? 0,
  );
  if (testValidationDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, testValidationDelayMs));
    process.exit(process.env.API_TYPECHECK_TEST_VALIDATION_FAIL === "1" ? 1 : 0);
  }

  const validation = spawn(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "typecheck"],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
    },
  );
  const activePath = process.env.API_TYPECHECK_VALIDATION_ACTIVE_PATH;
  let activePoll;
  if (activePath) {
    activePoll = setInterval(async () => {
      const generatedPathExists = (
        await Promise.all(lockedPaths.map(exists))
      ).some(Boolean);
      if (generatedPathExists) {
        await writeFile(activePath, "active\n", { flag: "wx" }).catch(() => {});
        clearInterval(activePoll);
      }
    }, 10);
  }
  const { code, signal } = await new Promise((resolve, reject) => {
    validation.once("error", reject);
    validation.once("exit", (childCode, childSignal) =>
      resolve({ code: childCode, signal: childSignal }),
    );
  });
  clearInterval(activePoll);
  process.exitCode = code ?? (signal ? 1 : 0);
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit();
}

function createLockEntry(canonicalPath) {
  const pathKey = createHash("sha256")
    .update(canonicalPath)
    .digest("hex")
    .slice(0, 16);
  const lockDirectory = path.join(
    os.tmpdir(),
    `api-typecheck-regression-${pathKey}.lock`,
  );
  const transitionLockDirectory = `${lockDirectory}.transition`;
  return {
    canonicalPath,
    lockDirectory,
    lockOwnerPath: path.join(lockDirectory, "owner.json"),
    transitionLockDirectory,
    transitionOwnerPath: path.join(transitionLockDirectory, "owner.json"),
  };
}

const lockEntries = canonicalLockedPaths.map(createLockEntry);
const primaryLockEntry = lockEntries[0];
const lockDirectory = primaryLockEntry.lockDirectory;
const lockOwnerPath = primaryLockEntry.lockOwnerPath;
const transitionLockDirectory = primaryLockEntry.transitionLockDirectory;
const transitionOwnerPath = primaryLockEntry.transitionOwnerPath;
const recoveryLockEntry = {
  transitionLockDirectory: path.join(
    os.tmpdir(),
    "api-typecheck-regression-recovery.transition",
  ),
  transitionOwnerPath: path.join(
    os.tmpdir(),
    "api-typecheck-regression-recovery.transition",
    "owner.json",
  ),
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function runCommandWithProcessTreeTimeout(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") spawnError = error;
        }
      }
    }, options.timeout);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString(options.encoding),
        stderr: Buffer.concat(stderr).toString(options.encoding),
        error: timedOut
          ? Object.assign(
              new Error(`Command timed out after ${options.timeout}ms`),
              { code: "ETIMEDOUT" },
            )
          : spawnError,
      });
    });
  });
}

async function readProcessIdentityCommand(
  pid,
  platform,
  runCommand = runCommandWithProcessTreeTimeout,
) {
  let command;
  let args;
  if (platform === "darwin" || platform === "freebsd") {
    command = "ps";
    args = ["-o", "lstart=", "-p", String(pid)];
  } else if (platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ];
  } else {
    return null;
  }

  let result;
  try {
    result = await runCommand(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: processIdentityCommandTimeoutMs,
    });
  } catch {
    return null;
  }
  if (result.status !== 0) return null;
  const identity = result.stdout?.trim();
  return identity ? `${platform}:${identity}` : null;
}

async function getProcessIdentity(
  pid = process.pid,
  platform = process.platform,
  runCommand = runCommandWithProcessTreeTimeout,
) {
  if (platform !== "linux") {
    return await readProcessIdentityCommand(pid, platform, runCommand);
  }
  const processStat = await readFile(`/proc/${pid}/stat`, "utf8").catch(
    () => null,
  );
  const startTime = processStat
    ?.slice(processStat.lastIndexOf(") ") + 2)
    .split(" ")[19];
  return startTime ?? null;
}

async function getOwnerProcessIdentity(pid) {
  if (unavailableProcessIdentityPids.has(pid)) {
    return null;
  }
  return getProcessIdentity(pid);
}

function processExists(pid, sendSignal = process.kill) {
  try {
    sendSignal(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function isOwnerAlive(
  owner,
  {
    platform = process.platform,
    hostname = os.hostname(),
    getIdentity = getOwnerProcessIdentity,
    exists = processExists,
  } = {},
) {
  return (
    (await getOwnerStatus(owner, {
      platform,
      hostname,
      getIdentity,
      exists,
    })) === "live"
  );
}

function getOwnerRecordValidationError(owner) {
  if (owner === null || owner === undefined) {
    return null;
  }
  if (
    !owner ||
    typeof owner !== "object" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  ) {
    return "recorded owner PID is missing or invalid";
  }
  if (typeof owner.hostname !== "string" || owner.hostname.trim() === "") {
    return "recorded owner hostname is missing or invalid";
  }
  // Identity is optional for legacy records and unavailable platform metadata.
  // Otherwise it is an opaque, nonblank string, not a platform-specific format.
  if (
    owner.processIdentity !== null &&
    owner.processIdentity !== undefined &&
    (typeof owner.processIdentity !== "string" ||
      owner.processIdentity.trim() === "")
  ) {
    return "recorded owner process identity is invalid";
  }
  return null;
}

async function getOwnerStatusDetails(
  owner,
  {
    platform = process.platform,
    hostname = os.hostname(),
    getIdentity = getOwnerProcessIdentity,
    exists = processExists,
  } = {},
) {
  if (getOwnerRecordValidationError(owner)) {
    return "malformed";
  }
  if (owner?.hostname !== hostname) {
    return "host-mismatch";
  }
  if (!Number.isInteger(owner?.pid)) {
    return "dead";
  }
  if (!exists(owner.pid)) return "dead";
  const currentIdentity = await getIdentity(owner.pid);
  if (!owner.processIdentity || !currentIdentity) {
    return "metadata-unavailable";
  }
  return currentIdentity === owner.processIdentity ? "live" : "reused";
}

async function getOwnerStatus(owner, options = {}) {
  const status = await getOwnerStatusDetails(owner, options);
  return status === "metadata-unavailable" ? "live" : status;
}

function formatLockOwnerAge(owner, now = Date.now()) {
  const createdAtMs =
    typeof owner?.createdAt === "string" ? Date.parse(owner.createdAt) : NaN;
  if (!Number.isFinite(createdAtMs)) {
    return "owner age: unavailable (missing or invalid createdAt)";
  }
  const ageMs = now - createdAtMs;
  if (ageMs < 0) {
    return "owner age: unavailable (createdAt is in the future)";
  }

  let remainingSeconds = Math.floor(ageMs / 1_000);
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds %= 86_400;
  const hours = Math.floor(remainingSeconds / 3_600);
  remainingSeconds %= 3_600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const units = [
    [days, "day"],
    [hours, "hour"],
    [minutes, "minute"],
    [seconds, "second"],
  ].filter(([value]) => value > 0);
  const duration =
    units
      .slice(0, 2)
      .map(([value, unit]) => `${value} ${unit}${value === 1 ? "" : "s"}`)
      .join(" ") || "0 seconds";
  return `owner age: ${duration}`;
}

function getLockOwnerReadErrorStatus(error) {
  return error.code === "ERR_NULL_LOCK_OWNER" ? "malformed" : "unavailable";
}

function formatLockOwnerReadIssue(error) {
  if (!error) return null;
  if (error.code === "ERR_NULL_LOCK_OWNER") {
    return "owner record is malformed (JSON null is not an owner record)";
  }
  if (error.code === "ENOENT") {
    return "owner record is unreadable (owner file is missing)";
  }
  if (error instanceof SyntaxError) {
    return "owner record is malformed (invalid JSON)";
  }
  const reason =
    error.code === "EACCES" || error.code === "EPERM"
      ? "permission denied; check owner-file and parent-directory read/search permissions"
      : "filesystem read failed; check owner-file access and filesystem health";
  return `owner record is unreadable${error.code ? ` (${error.code})` : ""}; ${reason}; safe cleanup is blocked, preserving the lock`;
}

function formatLockOwnerDetails(owner, status, ownerRecordReadError = null) {
  const ownerRecordIssue = formatLockOwnerReadIssue(ownerRecordReadError);
  const reportedStatus = ownerRecordReadError
    ? getLockOwnerReadErrorStatus(ownerRecordReadError)
    : !owner ? "unavailable" : status;
  return `${ownerRecordIssue ? `${ownerRecordIssue}; ` : ""}owner PID: ${Number.isInteger(owner?.pid) ? owner.pid : "unavailable"}, host: ${owner?.hostname || "unavailable"}, status: ${reportedStatus}, ${formatLockOwnerAge(owner)}`;
}

function testLockOwnerAgeFormatting() {
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  const cases = [
    {
      createdAt: undefined,
      expected: "owner age: unavailable (missing or invalid createdAt)",
    },
    {
      createdAt: "not-a-timestamp",
      expected: "owner age: unavailable (missing or invalid createdAt)",
    },
    {
      createdAt: new Date(now - 86_400_000).toISOString(),
      expected: "owner age: 1 day",
    },
    {
      createdAt: new Date(now - 3_600_000).toISOString(),
      expected: "owner age: 1 hour",
    },
    {
      createdAt: new Date(now - 59 * 60_000).toISOString(),
      expected: "owner age: 59 minutes",
    },
    {
      createdAt: new Date(now - (59 * 60_000 + 59_000)).toISOString(),
      expected: "owner age: 59 minutes 59 seconds",
    },
    {
      createdAt: new Date(now - 3_599_999).toISOString(),
      expected: "owner age: 59 minutes 59 seconds",
    },
    {
      createdAt: new Date(now - 60_000).toISOString(),
      expected: "owner age: 1 minute",
    },
    {
      createdAt: new Date(now - 59_000).toISOString(),
      expected: "owner age: 59 seconds",
    },
    {
      createdAt: new Date(now - 59_999).toISOString(),
      expected: "owner age: 59 seconds",
    },
    {
      createdAt: new Date(now - 1_999).toISOString(),
      expected: "owner age: 1 second",
    },
    {
      createdAt: new Date(now - 1_000).toISOString(),
      expected: "owner age: 1 second",
    },
    {
      createdAt: new Date(now - 999).toISOString(),
      expected: "owner age: 0 seconds",
    },
    {
      createdAt: new Date(now).toISOString(),
      expected: "owner age: 0 seconds",
    },
    {
      createdAt: new Date(
        now - (2 * 86_400_000 + 3 * 3_600_000 + 17 * 60_000 + 42 * 1_000),
      ).toISOString(),
      expected: "owner age: 2 days 3 hours",
    },
    {
      createdAt: new Date(
        now - (7 * 3_600_000 + 12 * 60_000 + 34 * 1_000),
      ).toISOString(),
      expected: "owner age: 7 hours 12 minutes",
    },
    {
      createdAt: new Date(now + 1_000).toISOString(),
      expected: "owner age: unavailable (createdAt is in the future)",
    },
  ];

  for (const { createdAt, expected } of cases) {
    const actual = formatLockOwnerAge({ createdAt }, now);
    if (actual !== expected) {
      throw new Error(
        `Lock owner age formatting mismatch: expected "${expected}", received "${actual}"`,
      );
    }
  }
}

async function formatLockFilesystemDetails(
  lockEntry,
  { transition = false, owner = null, ownerStatus = null } = {},
) {
  const lockDirectory = transition
    ? lockEntry.transitionLockDirectory
    : lockEntry.lockDirectory;
  const ownerPath = transition
    ? lockEntry.transitionOwnerPath
    : lockEntry.lockOwnerPath;
  const { owner: recordedOwner, error: ownerRecordReadError } =
    await readLockOwnerRecord(ownerPath);
  const recordedOwnerStatus =
    ownerStatus ??
    (ownerRecordReadError
      ? getLockOwnerReadErrorStatus(ownerRecordReadError)
      : recordedOwner
        ? await getOwnerStatusDetails(recordedOwner)
        : owner
          ? await getOwnerStatusDetails(owner)
          : "unavailable");
  const ownerRecordIssue = formatLockOwnerReadIssue(ownerRecordReadError);
  const [lockDirectoryRemains, ownerFileRemains] = await Promise.all([
    exists(lockDirectory),
    exists(ownerPath),
  ]);
  return {
    ownerStatus: recordedOwnerStatus,
    filesystemState: {
      lockDirectory: {
        path: lockDirectory,
        remains: lockDirectoryRemains,
      },
      ownerFile: {
        path: ownerPath,
        remains: ownerFileRemains,
      },
    },
    message: `recorded owner status: ${recordedOwnerStatus}${ownerRecordIssue ? `; ${ownerRecordIssue}` : ""}; lock directory remained: ${lockDirectoryRemains ? "yes" : "no"}; owner file remained: ${ownerFileRemains ? "yes" : "no"}`,
  };
}

async function createLockDiagnosticError(
  error,
  lockEntry,
  { phase, transition = false, owner = null, ownerStatus = null, preserveMessage = false },
) {
  const message = error instanceof Error ? error.message : String(error);
  const alreadyFormatted = message.startsWith(
    "Transition-lock handoff failed (phase:",
  );
  if (alreadyFormatted && error?.lockDiagnostic) {
    return error;
  }
  const filesystemDetails = await formatLockFilesystemDetails(lockEntry, {
    transition,
    owner,
    ownerStatus,
  });
  const diagnostic = {
    schemaVersion: 1,
    phase,
    canonicalOutput: lockEntry.canonicalPath,
    transition,
    ownerStatus: filesystemDetails.ownerStatus,
    filesystemState: filesystemDetails.filesystemState,
  };
  const diagnosticError =
    (alreadyFormatted || preserveMessage) && error instanceof Error
      ? error
      : new Error(
          `Transition-lock handoff failed (phase: ${phase}) for canonical output ${lockEntry.canonicalPath}: ${message}; ${filesystemDetails.message}`,
          { cause: error },
        );
  diagnosticError.lockDiagnostic = diagnostic;
  diagnosticError.lockDiagnostics = [diagnostic];
  return diagnosticError;
}

async function testNullLockOwner(entry, { transition = false } = {}) {
  const directory = transition ? entry.transitionLockDirectory : entry.lockDirectory;
  const ownerPath = transition ? entry.transitionOwnerPath : entry.lockOwnerPath;
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory);
  const contents = "null\n";
  await writeFile(ownerPath, contents, { flag: "wx" });
  const staleTimestamp = new Date(Date.now() - Math.max(lockStaleAfterMs, 30_000) - 1_000);
  await utimes(directory, staleTimestamp, staleTimestamp);
  const before = await Promise.all([stat(directory), stat(ownerPath)]);
  let failure;
  try {
    if (transition) {
      await acquireTransitionLock(entry, { waitTimeoutMs: 250 });
    } else {
      await acquireLock([entry], { waitTimeoutMs: 250 });
    }
  } catch (error) {
    failure = error;
  }
  const expectedParts = [
    `Timed out waiting for API typecheck regression ${transition ? "transition " : ""}lock`,
    `canonical output ${entry.canonicalPath}`,
    "owner record is malformed (JSON null is not an owner record)",
    "status: malformed",
  ];
  if (expectedParts.some((part) => !failure?.message.includes(part))) {
    throw new Error("Incorrect JSON null lock-owner timeout diagnostic", { cause: failure });
  }
  const after = await Promise.all([stat(directory), stat(ownerPath)]);
  if (
    (await readFile(ownerPath, "utf8")) !== contents ||
    before.some((snapshot, index) =>
      ["ino", "dev", "mode", "size", "mtimeMs", "ctimeMs"].some(
        (key) => snapshot[key] !== after[index][key],
      ),
    )
  ) {
    throw new Error("JSON null owner timeout mutated the lock or owner file");
  }
}

async function testOwnerFilesystemReadFailures(entry, { transition = false } = {}) {
  const directory = transition
    ? entry.transitionLockDirectory
    : entry.lockDirectory;
  const ownerPath = transition ? entry.transitionOwnerPath : entry.lockOwnerPath;
  const staleTimestamp = new Date(
    Date.now() - Math.max(lockStaleAfterMs, 30_000) - 1_000,
  );
  for (const { code, recover = false, fresh = false } of [
    { code: "EACCES" },
    { code: "EPERM" },
    { code: "EIO" },
    { code: undefined },
    { code: "EACCES", recover: true },
    // A readable but not-yet-stale dead owner must time out with its current
    // status, not the permission error from an earlier observation.
    { code: "EACCES", recover: true, fresh: true },
  ]) {
    await rm(directory, { force: true, recursive: true });
    await mkdir(directory);
    const contents = `${JSON.stringify({
      pid: 2147483647,
      hostname: os.hostname(),
      token: randomUUID(),
      createdAt: staleTimestamp.toISOString(),
    })}\n`;
    await writeFile(ownerPath, contents, { flag: "wx" });
    const timestamp = fresh ? new Date(Date.now() + 60_000) : staleTimestamp;
    await utimes(directory, timestamp, timestamp);
    const before = await Promise.all([stat(directory), stat(ownerPath)]);
    const assertUnchanged = async () => {
      const after = await Promise.all([stat(directory), stat(ownerPath)]);
      if (
        (await readFile(ownerPath, "utf8")) !== contents ||
        before.some((snapshot, index) =>
          ["ino", "dev", "mode", "size", "mtimeMs", "ctimeMs"].some(
            (key) => snapshot[key] !== after[index][key],
          ),
        )
      ) {
        throw new Error(`${code} owner-read retry mutated the lock or owner file`);
      }
    };
    let reads = 0;
    const sensitiveReadMessage = "PRIVATE_OWNER_READ_SENTINEL_do_not_publish";
    // Inject at the filesystem-read boundary: chmod is ineffective under root
    // and has different semantics on Windows. Keep a real owner file to verify.
    const readOwner = async (filePath) => {
      if (filePath !== ownerPath) {
        throw new Error(`Unexpected owner read: ${filePath}`);
      }
      reads += 1;
      // Also inspect at the first readable observation, before takeover, so
      // mutation after the last failed read cannot escape the assertion.
      await assertUnchanged();
      if (recover && reads > 2) {
        return readJson(filePath);
      }
      const error = new Error(sensitiveReadMessage);
      if (code !== undefined) error.code = code;
      throw error;
    };
    let failure;
    let acquiredOwner;
    try {
      const options = {
        waitTimeoutMs: recover && !fresh ? 2_000 : 250,
        readOwner,
      };
      if (transition) {
        acquiredOwner = await acquireTransitionLock(entry, options);
      } else {
        acquiredOwner = await acquireLock([entry], options);
      }
    } catch (error) {
      failure = error;
    }
    if (recover && !fresh) {
      try {
        const recordedOwner = await readJson(ownerPath);
        if (
          failure ||
          reads !== 3 ||
          !acquiredOwner ||
          recordedOwner.token !== acquiredOwner.token ||
          recordedOwner.token === JSON.parse(contents).token ||
          (await getOwnerStatus(recordedOwner)) !== "live" ||
          acquiredOwner.lockDiagnostic ||
          acquiredOwner.lockDiagnostics
        ) {
          throw new Error("Owner-read recovery did not safely acquire a fresh lock", {
            cause: failure,
          });
        }
      } finally {
        if (acquiredOwner) {
          if (transition) {
            await releaseTransitionLock(acquiredOwner, entry);
          } else {
            await releaseLock(acquiredOwner, [entry]);
          }
        }
      }
      if (
        (await exists(directory)) ||
        (await exists(entry.transitionLockDirectory))
      ) {
        throw new Error("Owner-read recovery left a lock behind after release");
      }
      continue;
    }
    if (recover) {
      if (
        reads < 3 ||
        !failure?.message.includes("Timed out waiting for API typecheck regression") ||
        !failure.message.includes(`canonical output ${entry.canonicalPath}`) ||
        !failure.message.includes("status: dead") ||
        /unreadable|EACCES|status: unavailable/.test(failure.message) ||
        failure.message.includes(JSON.parse(contents).token) ||
        failure.lockDiagnostic?.ownerStatus !== "dead"
      ) {
        throw new Error("Recovered owner read retained an obsolete diagnostic", {
          cause: failure,
        });
      }
      await assertUnchanged();
      continue;
    }
    const expectedReason =
      code === "EACCES" || code === "EPERM"
        ? "permission denied; check owner-file and parent-directory read/search permissions"
        : "filesystem read failed; check owner-file access and filesystem health";
    const expectedParts = [
      `Timed out waiting for API typecheck regression ${transition ? "transition " : ""}lock`,
      `canonical output ${entry.canonicalPath}`,
      `owner record is unreadable${code ? ` (${code})` : ""};`,
      expectedReason,
      "safe cleanup is blocked, preserving the lock",
      "status: unavailable",
    ];
    if (
      reads < 2 ||
      expectedParts.some((part) => !failure?.message.includes(part)) ||
      failure?.message.includes(JSON.parse(contents).token) ||
      inspect(failure, { depth: null }).includes(sensitiveReadMessage) ||
      JSON.stringify(collectLockDiagnostics(failure)).includes(sensitiveReadMessage)
    ) {
      throw new Error(`Incorrect ${code ?? "code-less"} owner-read timeout diagnostic`, {
        cause: failure,
      });
    }
    await assertUnchanged();
  }
}

async function testPerPathLockTakeover() {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "api-typecheck-lock-identity-"),
  );
  const testPaths = [
    "first",
    "later",
    "blocked",
    "live",
    "reused",
    "metadata-unavailable",
    "foreign-host",
    "missing-timestamp",
    "missing-pid",
    "invalid-pid",
    "missing-hostname",
    "invalid-hostname",
    "invalid-process-identity",
    "missing-owner",
    "invalid-json-owner",
  ].map((name) => path.join(testDirectory, name));
  const testEntries = await Promise.all(
    testPaths.map(async (testPath) =>
      createLockEntry(await canonicalizePath(testPath)),
    ),
  );
  const [
    firstEntry,
    laterEntry,
    blockedEntry,
    liveEntry,
    reusedEntry,
    metadataUnavailableEntry,
    foreignHostEntry,
    missingTimestampEntry,
    missingPidEntry,
    invalidPidEntry,
    missingHostnameEntry,
    invalidHostnameEntry,
    invalidProcessIdentityEntry,
    missingOwnerEntry,
    invalidJsonOwnerEntry,
  ] = testEntries;
  const staleTimestamp = new Date(
    Date.now() - Math.max(lockStaleAfterMs, 30_000) - 1_000,
  );
  const currentProcessIdentity = await getProcessIdentity();
  const liveOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processIdentity: currentProcessIdentity,
    createdAt: staleTimestamp.toISOString(),
  };
  const reusedOwner = {
    ...liveOwner,
    token: randomUUID(),
    processIdentity: currentProcessIdentity
      ? `${currentProcessIdentity}-replacement`
      : "replacement-process-identity",
  };
  const metadataUnavailableOwner = {
    ...liveOwner,
    token: randomUUID(),
    processIdentity: undefined,
  };
  const foreignHostOwner = {
    ...liveOwner,
    token: randomUUID(),
    hostname: "different-test-host",
  };
  const staleOwner = {
    token: randomUUID(),
    pid: 2_147_483_647,
    hostname: os.hostname(),
    processIdentity: "terminated-process-identity",
    createdAt: staleTimestamp.toISOString(),
  };

  async function writeStaleLock(lockEntry, owner) {
    await mkdir(lockEntry.lockDirectory);
    await writeFile(lockEntry.lockOwnerPath, `${JSON.stringify(owner)}\n`, {
      flag: "wx",
    });
    await utimes(lockEntry.lockDirectory, staleTimestamp, staleTimestamp);
  }

  async function assertOwnerRemains(lockEntry, owner, description) {
    const currentOwner = await readJson(lockEntry.lockOwnerPath).catch(
      () => null,
    );
    if (currentOwner?.token !== owner.token) {
      throw new Error(`${description} was reclaimed or replaced`);
    }
  }

  try {
    // The first lock must be released when a later lock cannot be acquired.
    // The stale lock in between proves that every per-path lock participates
    // in stale takeover, not just the first configured path.
    await writeStaleLock(laterEntry, staleOwner);
    await writeStaleLock(blockedEntry, liveOwner);
    let partialAcquisitionError;
    try {
      await acquireLock([firstEntry, laterEntry, blockedEntry], {
        waitTimeoutMs: 250,
      });
    } catch (error) {
      partialAcquisitionError = error;
    }
    if (
      !partialAcquisitionError?.message.includes(
        "Timed out waiting for API typecheck regression lock",
      ) ||
      !partialAcquisitionError.message.includes(
        `canonical output ${blockedEntry.canonicalPath}`,
      ) ||
      !partialAcquisitionError.message.includes(`owner PID: ${process.pid}`) ||
      !partialAcquisitionError.message.includes(
        `host: ${os.hostname()}, status: live`,
      ) ||
      !partialAcquisitionError.message.includes("owner age: ") ||
      partialAcquisitionError.message.includes(liveOwner.token)
    ) {
      throw (
        partialAcquisitionError ??
        new Error("Partial per-path lock acquisition unexpectedly succeeded")
      );
    }
    if (
      (await exists(firstEntry.lockDirectory)) ||
      (await exists(laterEntry.lockDirectory))
    ) {
      throw new Error(
        "Partial per-path lock acquisition left an earlier lock behind",
      );
    }
    await assertOwnerRemains(
      blockedEntry,
      liveOwner,
      "Live per-path lock owner",
    );
    const outputDiagnostic = partialAcquisitionError.lockDiagnostic;
    if (
      outputDiagnostic?.schemaVersion !== 1 ||
      outputDiagnostic.phase !== "output-lock-acquire" ||
      outputDiagnostic.canonicalOutput !== blockedEntry.canonicalPath ||
      outputDiagnostic.transition !== false ||
      outputDiagnostic.ownerStatus !== await getOwnerStatusDetails(liveOwner) ||
      outputDiagnostic.filesystemState?.lockDirectory?.path !== blockedEntry.lockDirectory ||
      outputDiagnostic.filesystemState?.lockDirectory?.remains !== true ||
      outputDiagnostic.filesystemState?.ownerFile?.path !== blockedEntry.lockOwnerPath ||
      outputDiagnostic.filesystemState?.ownerFile?.remains !== true ||
      partialAcquisitionError.lockDiagnostics?.length !== 1 ||
      partialAcquisitionError.lockDiagnostics[0] !== outputDiagnostic
    ) {
      throw new Error("Blocked output lock did not expose structured acquisition diagnostics");
    }
    if (
      !partialAcquisitionError.message.startsWith(
        `Timed out waiting for API typecheck regression lock for canonical output ${blockedEntry.canonicalPath}: `,
      ) ||
      !partialAcquisitionError.message.endsWith(
        `(lock directory: ${blockedEntry.lockDirectory})`,
      )
    ) {
      throw new Error("Output-lock diagnostics changed the existing timeout message");
    }

    await rm(blockedEntry.lockDirectory, { force: true, recursive: true });
    await writeStaleLock(liveEntry, liveOwner);
    let liveOwnerError;
    try {
      await acquireLock([liveEntry], { waitTimeoutMs: 250 });
    } catch (error) {
      liveOwnerError = error;
    }
    if (
      !liveOwnerError?.message.includes(
        "Timed out waiting for API typecheck regression lock",
      ) ||
      !liveOwnerError.message.includes(
        `canonical output ${liveEntry.canonicalPath}`,
      ) ||
      !liveOwnerError.message.includes(`owner PID: ${process.pid}`) ||
      !liveOwnerError.message.includes(
        `host: ${os.hostname()}, status: live`,
      ) ||
      !liveOwnerError.message.includes("owner age: ") ||
      liveOwnerError.message.includes(liveOwner.token)
    ) {
      throw (
        liveOwnerError ??
        new Error("Live per-path lock owner was unexpectedly reclaimed")
      );
    }
    await assertOwnerRemains(liveEntry, liveOwner, "Live per-path lock owner");

    await rm(liveEntry.lockDirectory, { force: true, recursive: true });
    await writeStaleLock(reusedEntry, reusedOwner);
    let reusedOwnerError;
    try {
      await acquireLock([reusedEntry], { waitTimeoutMs: 250 });
    } catch (error) {
      reusedOwnerError = error;
    }
    if (
      !reusedOwnerError?.message.includes(
        "Timed out waiting for API typecheck regression lock",
      ) ||
      !reusedOwnerError.message.includes(
        `canonical output ${reusedEntry.canonicalPath}`,
      ) ||
      !reusedOwnerError.message.includes(`owner PID: ${process.pid}`) ||
      !reusedOwnerError.message.includes(
        `host: ${os.hostname()}, status: reused`,
      ) ||
      reusedOwnerError.message.includes(reusedOwner.token)
    ) {
      throw (
        reusedOwnerError ??
        new Error("PID-reused per-path lock owner was unexpectedly reclaimed")
      );
    }
    await assertOwnerRemains(
      reusedEntry,
      reusedOwner,
      "PID-reused per-path lock owner",
    );

    await rm(reusedEntry.lockDirectory, { force: true, recursive: true });
    await writeStaleLock(metadataUnavailableEntry, metadataUnavailableOwner);
    let metadataUnavailableOwnerError;
    try {
      await acquireLock([metadataUnavailableEntry], { waitTimeoutMs: 250 });
    } catch (error) {
      metadataUnavailableOwnerError = error;
    }
    if (
      !metadataUnavailableOwnerError?.message.includes(
        "Timed out waiting for API typecheck regression lock",
      ) ||
      !metadataUnavailableOwnerError.message.includes(
        `canonical output ${metadataUnavailableEntry.canonicalPath}`,
      ) ||
      !metadataUnavailableOwnerError.message.includes(
        `owner PID: ${process.pid}`,
      ) ||
      !metadataUnavailableOwnerError.message.includes(
        `host: ${os.hostname()}, status: metadata-unavailable`,
      ) ||
      metadataUnavailableOwnerError.message.includes(
        metadataUnavailableOwner.token,
      )
    ) {
      throw (
        metadataUnavailableOwnerError ??
        new Error(
          "Metadata-unavailable per-path lock owner was unexpectedly reclaimed",
        )
      );
    }
    await assertOwnerRemains(
      metadataUnavailableEntry,
      metadataUnavailableOwner,
      "Metadata-unavailable per-path lock owner",
    );

    await rm(metadataUnavailableEntry.lockDirectory, {
      force: true,
      recursive: true,
    });
    await writeStaleLock(foreignHostEntry, foreignHostOwner);
    let foreignHostOwnerError;
    try {
      await acquireLock([foreignHostEntry], { waitTimeoutMs: 250 });
    } catch (error) {
      foreignHostOwnerError = error;
    }
    if (
      !foreignHostOwnerError?.message.includes(
        "Timed out waiting for API typecheck regression lock",
      ) ||
      !foreignHostOwnerError.message.includes(
        `canonical output ${foreignHostEntry.canonicalPath}`,
      ) ||
      !foreignHostOwnerError.message.includes(`owner PID: ${process.pid}`) ||
      !foreignHostOwnerError.message.includes(
        `host: ${foreignHostOwner.hostname}, status: host-mismatch`,
      ) ||
      foreignHostOwnerError.message.includes(foreignHostOwner.token)
    ) {
      throw (
        foreignHostOwnerError ??
        new Error("Foreign-host per-path lock owner was unexpectedly reclaimed")
      );
    }
    await assertOwnerRemains(
      foreignHostEntry,
      foreignHostOwner,
      "Foreign-host per-path lock owner",
    );

    await rm(foreignHostEntry.lockDirectory, {
      force: true,
      recursive: true,
    });
    const missingTimestampOwner = { ...liveOwner, token: randomUUID() };
    delete missingTimestampOwner.createdAt;
    await writeStaleLock(missingTimestampEntry, missingTimestampOwner);
    let missingTimestampOwnerError;
    try {
      await acquireLock([missingTimestampEntry], { waitTimeoutMs: 250 });
    } catch (error) {
      missingTimestampOwnerError = error;
    }
    if (
      !missingTimestampOwnerError?.message.includes(
        "Timed out waiting for API typecheck regression lock",
      ) ||
      !missingTimestampOwnerError.message.includes(
        "owner age: unavailable (missing or invalid createdAt)",
      ) ||
      missingTimestampOwnerError.message.includes(missingTimestampOwner.token)
    ) {
      throw (
        missingTimestampOwnerError ??
        new Error(
          "Missing-timestamp per-path lock owner was unexpectedly reclaimed",
        )
      );
    }
    await assertOwnerRemains(
      missingTimestampEntry,
      missingTimestampOwner,
      "Missing-timestamp per-path lock owner",
    );

    const malformedOwnerCases = [
      {
        entry: missingPidEntry,
        owner: (() => {
          const owner = { ...liveOwner, token: randomUUID() };
          delete owner.pid;
          return owner;
        })(),
        description: "Missing-PID per-path lock owner",
      },
      {
        entry: invalidPidEntry,
        owner: {
          ...liveOwner,
          token: randomUUID(),
          pid: 0,
        },
        description: "Invalid-PID per-path lock owner",
      },
      {
        entry: missingHostnameEntry,
        owner: (() => {
          const owner = { ...liveOwner, token: randomUUID() };
          delete owner.hostname;
          return owner;
        })(),
        description: "Missing-hostname per-path lock owner",
      },
      {
        entry: invalidHostnameEntry,
        owner: {
          ...liveOwner,
          token: randomUUID(),
          hostname: "",
        },
        description: "Invalid-hostname per-path lock owner",
      },
      ...invalidProcessIdentityValues.map((processIdentity, index) => ({
        entry: invalidProcessIdentityEntry,
        owner: { ...liveOwner, token: randomUUID(), processIdentity },
        description: `Invalid-process-identity per-path lock owner (${index})`,
      })),
    ];
    for (const { entry, owner, description } of malformedOwnerCases) {
      await rm(entry.lockDirectory, { force: true, recursive: true });
      await writeStaleLock(entry, owner);
      const before = await fingerprint(entry.lockDirectory);
      let malformedOwnerError;
      try {
        await acquireLock([entry], { waitTimeoutMs: 250 });
      } catch (error) {
        malformedOwnerError = error;
      }
      if (
        !malformedOwnerError?.message.includes(
          "Timed out waiting for API typecheck regression lock",
        ) ||
        !malformedOwnerError.message.includes(
          `canonical output ${entry.canonicalPath}`,
        ) ||
        !malformedOwnerError.message.includes("status: malformed") ||
        /reused|PID[- ]reuse/i.test(
          `${malformedOwnerError.message} ${JSON.stringify(malformedOwnerError.lockDiagnostics)}`,
        ) ||
        malformedOwnerError.message.includes(owner.token)
      ) {
        throw (
          malformedOwnerError ??
          new Error(`${description} was unexpectedly reclaimed`)
        );
      }
      if (!(await exists(entry.lockDirectory))) {
        throw new Error(`${description} lock directory was reclaimed`);
      }
      await assertOwnerRemains(entry, owner, description);
      if (
        JSON.stringify(await fingerprint(entry.lockDirectory)) !==
        JSON.stringify(before)
      ) {
        throw new Error(`${description} lock contents changed after timeout`);
      }
      if (owner.pid === process.pid && !processExists(owner.pid)) {
        throw new Error(`${description} live recorded process did not survive`);
      }
    }

    const unreadableOwnerCases = [
      {
        entry: missingOwnerEntry,
        ownerContents: null,
        description: "Missing-owner per-path lock",
        expectedIssue: "owner record is unreadable (owner file is missing)",
      },
      {
        entry: invalidJsonOwnerEntry,
        ownerContents: "{ invalid json\n",
        description: "Invalid-JSON per-path lock owner",
        expectedIssue: "owner record is malformed (invalid JSON)",
      },
    ];
    for (const {
      entry,
      ownerContents,
      description,
      expectedIssue,
    } of unreadableOwnerCases) {
      await rm(entry.lockDirectory, { force: true, recursive: true });
      await mkdir(entry.lockDirectory);
      if (ownerContents !== null) {
        await writeFile(entry.lockOwnerPath, ownerContents, { flag: "wx" });
      }
      await utimes(entry.lockDirectory, staleTimestamp, staleTimestamp);

      let unreadableOwnerError;
      try {
        await acquireLock([entry], { waitTimeoutMs: 250 });
      } catch (error) {
        unreadableOwnerError = error;
      }
      if (
        !unreadableOwnerError?.message.includes(
          "Timed out waiting for API typecheck regression lock",
        ) ||
        !unreadableOwnerError.message.includes(
          `canonical output ${entry.canonicalPath}`,
        ) ||
        !unreadableOwnerError.message.includes(expectedIssue)
      ) {
        throw (
          unreadableOwnerError ??
          new Error(`${description} was unexpectedly reclaimed`)
        );
      }
      if (!(await exists(entry.lockDirectory))) {
        throw new Error(`${description} lock directory was reclaimed`);
      }
      if (ownerContents === null) {
        if (await exists(entry.lockOwnerPath)) {
          throw new Error(`${description} unexpectedly gained an owner file`);
        }
      } else if (
        (await readFile(entry.lockOwnerPath, "utf8")) !== ownerContents
      ) {
        throw new Error(`${description} owner record changed after timeout`);
      }
    }
    await testOwnerFilesystemReadFailures(invalidJsonOwnerEntry);
    await testNullLockOwner(invalidJsonOwnerEntry);
  } finally {
    await Promise.all(
      testEntries.flatMap((lockEntry) => [
        rm(lockEntry.lockDirectory, { force: true, recursive: true }),
        rm(lockEntry.transitionLockDirectory, {
          force: true,
          recursive: true,
        }),
      ]),
    );
    await rm(testDirectory, { force: true, recursive: true });
  }
}

async function testTransitionLockTakeover() {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "api-typecheck-transition-lock-identity-"),
  );
  const transitionEntry = createLockEntry(
    path.join(testDirectory, "transition-output"),
  );
  const staleTimestamp = new Date(
    Date.now() - Math.max(lockStaleAfterMs, 30_000) - 1_000,
  );
  const currentProcessIdentity = await getProcessIdentity();
  const liveOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processIdentity: currentProcessIdentity,
    createdAt: staleTimestamp.toISOString(),
  };
  const reusedOwner = {
    ...liveOwner,
    token: randomUUID(),
    processIdentity: currentProcessIdentity
      ? `${currentProcessIdentity}-replacement`
      : "replacement-process-identity",
  };
  const metadataUnavailableOwner = {
    ...liveOwner,
    token: randomUUID(),
    processIdentity: undefined,
  };
  const foreignHostOwner = {
    ...liveOwner,
    token: randomUUID(),
    hostname: "different-test-host",
  };
  const deadOwner = {
    token: randomUUID(),
    pid: 2_147_483_647,
    hostname: os.hostname(),
    processIdentity: "terminated-process-identity",
    createdAt: staleTimestamp.toISOString(),
  };
  let phase = "transition-lock-test-setup";
  const exitingOwnerDirectory = await mkdtemp(
    path.join(os.tmpdir(), "api-typecheck-transition-lock-exit-"),
  );
  const exitingOwnerReadyPath = path.join(exitingOwnerDirectory, "ready");
  const exitingOwnerEntry = createLockEntry(
    path.join(exitingOwnerDirectory, "transition-output"),
  );

  async function writeStaleTransitionLockContents(ownerContents) {
    await mkdir(transitionEntry.transitionLockDirectory);
    if (ownerContents !== null) {
      await writeFile(transitionEntry.transitionOwnerPath, ownerContents, {
        flag: "wx",
      });
    }
    await utimes(
      transitionEntry.transitionLockDirectory,
      staleTimestamp,
      staleTimestamp,
    );
  }

  async function writeStaleTransitionLock(owner) {
    await writeStaleTransitionLockContents(`${JSON.stringify(owner)}\n`);
  }

  async function assertTransitionOwnerRemains(owner, description) {
    let timeoutError;
    try {
      await acquireTransitionLock(transitionEntry, { waitTimeoutMs: 250 });
    } catch (error) {
      timeoutError = error;
    }
    const expectedStatus = await getOwnerStatusDetails(owner);
    const expectedObservedStatus =
      expectedStatus === "metadata-unavailable" ? "live" : expectedStatus;
    const lockDiagnostic = timeoutError?.lockDiagnostic;
    if (
      !timeoutError?.message.includes(
        "Timed out waiting for API typecheck regression transition lock",
      ) ||
      !timeoutError.message.includes(
        `canonical output ${transitionEntry.canonicalPath}`,
      ) ||
      !timeoutError.message.includes(`owner PID: ${process.pid}`) ||
      !timeoutError.message.includes(
        `host: ${owner.hostname}, status: ${expectedStatus}`,
      ) ||
      !timeoutError.message.includes("owner age: ") ||
      !timeoutError.message.includes("phase: owner-observed-") ||
      !timeoutError.message.includes(
        `canonical output ${transitionEntry.canonicalPath}`,
      ) ||
      !timeoutError.message.includes("recorded owner status: ") ||
      !timeoutError.message.includes("lock directory remained: ") ||
      !timeoutError.message.includes("owner file remained: ") ||
      timeoutError.message.includes(owner.token) ||
      lockDiagnostic?.schemaVersion !== 1 ||
      lockDiagnostic.phase !== `owner-observed-${expectedObservedStatus}` ||
      lockDiagnostic.canonicalOutput !== transitionEntry.canonicalPath ||
      lockDiagnostic.transition !== true ||
      lockDiagnostic.ownerStatus !== expectedStatus ||
      lockDiagnostic.filesystemState?.lockDirectory?.path !==
        transitionEntry.transitionLockDirectory ||
      lockDiagnostic.filesystemState?.lockDirectory?.remains !== true ||
      lockDiagnostic.filesystemState?.ownerFile?.path !==
        transitionEntry.transitionOwnerPath ||
      lockDiagnostic.filesystemState?.ownerFile?.remains !== true ||
      timeoutError.lockDiagnostics?.[0] !== lockDiagnostic
    ) {
      throw (
        timeoutError ?? new Error(`${description} was unexpectedly reclaimed`)
      );
    }
    const currentOwner = await readJson(
      transitionEntry.transitionOwnerPath,
    ).catch(() => null);
    if (currentOwner?.token !== owner.token) {
      throw await createLockDiagnosticError(
        new Error(`${description} was reclaimed or replaced`),
        transitionEntry,
        {
          phase: "owner-observation",
          transition: true,
          owner,
          ownerStatus: await getOwnerStatusDetails(owner),
        },
      );
    }
  }

  let exitingOwnerChild;
  try {
    phase = "owner-fixture-startup";
    exitingOwnerChild = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--run-transition-lock-owner-fixture"],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          API_TYPECHECK_TRANSITION_LOCK_DIRECTORY:
            exitingOwnerEntry.transitionLockDirectory,
          API_TYPECHECK_TRANSITION_OWNER_PATH:
            exitingOwnerEntry.transitionOwnerPath,
          API_TYPECHECK_TRANSITION_READY_PATH: exitingOwnerReadyPath,
          API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
        },
        stdio: "inherit",
      },
    );
    const readyDeadline = Date.now() + 30_000;
    phase = "owner-fixture-ready";
    while (!(await exists(exitingOwnerReadyPath))) {
      if (
        exitingOwnerChild.exitCode !== null ||
        exitingOwnerChild.signalCode !== null
      ) {
        throw new Error(
          "Transition-lock owner fixture exited before becoming ready",
        );
      }
      if (Date.now() > readyDeadline) {
        throw new Error("Timed out waiting for transition-lock owner fixture");
      }
      await sleep(25);
    }

    let resolveLiveObservation;
    let rejectLiveObservation;
    const liveObservation = new Promise((resolve, reject) => {
      resolveLiveObservation = resolve;
      rejectLiveObservation = reject;
    });
    const contender = acquireTransitionLock(exitingOwnerEntry, {
      waitTimeoutMs: 5_000,
      onOwnerStatus: async ({ owner, status }) => {
        if (status !== "live") return;
        phase = "owner-observed-live";
        const currentOwner = await readJson(
          exitingOwnerEntry.transitionOwnerPath,
        ).catch(() => null);
        if (
          currentOwner?.token !== owner.token ||
          !(await exists(exitingOwnerEntry.transitionLockDirectory))
        ) {
          throw new Error(
            "Transition contender observed a live owner after the lock changed",
          );
        }
        resolveLiveObservation();
      },
    });
    contender.then(() => {}, rejectLiveObservation);
    await liveObservation;

    phase = "owner-exit";
    if (!exitingOwnerChild.kill()) {
      throw new Error(
        `Could not terminate transition-lock owner child ${exitingOwnerChild.pid}`,
      );
    }
    await new Promise((resolve, reject) => {
      exitingOwnerChild.once("error", reject);
      exitingOwnerChild.once("exit", resolve);
    });

    phase = "stale-takeover-after-owner-exit";
    const acquiredOwner = await contender;
    const currentOwner = await readJson(exitingOwnerEntry.transitionOwnerPath);
    if (
      currentOwner.token !== acquiredOwner.token ||
      currentOwner.pid !== process.pid
    ) {
      throw new Error(
        "Transition contender did not reclaim the lock after its owner exited",
      );
    }
    phase = "transition-lock-release";
    await releaseTransitionLock(acquiredOwner, exitingOwnerEntry);
    if (
      (await exists(exitingOwnerEntry.transitionLockDirectory)) ||
      (await exists(exitingOwnerEntry.transitionOwnerPath))
    ) {
      throw new Error(
        "Transition lock or owner file remained after exit-race takeover release",
      );
    }
  } catch (error) {
    throw await createLockDiagnosticError(error, exitingOwnerEntry, {
      phase,
      transition: true,
    });
  } finally {
    if (
      exitingOwnerChild &&
      exitingOwnerChild.exitCode === null &&
      exitingOwnerChild.signalCode === null
    ) {
      exitingOwnerChild.kill();
      await new Promise((resolve) => exitingOwnerChild.once("exit", resolve));
    }
    await rm(exitingOwnerDirectory, { force: true, recursive: true });
  }

  try {
    phase = "owner-observed-live";
    await writeStaleTransitionLock(liveOwner);
    await assertTransitionOwnerRemains(liveOwner, "Live transition-lock owner");

    phase = "owner-observed-reused";
    await rm(transitionEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
    await writeStaleTransitionLock(reusedOwner);
    await assertTransitionOwnerRemains(
      reusedOwner,
      "PID-reused transition-lock owner",
    );

    phase = "stale-takeover";
    await rm(transitionEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
    await writeStaleTransitionLock(metadataUnavailableOwner);
    await assertTransitionOwnerRemains(
      metadataUnavailableOwner,
      "Metadata-unavailable transition-lock owner",
    );

    await rm(transitionEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
    await writeStaleTransitionLock(foreignHostOwner);
    await assertTransitionOwnerRemains(
      foreignHostOwner,
      "Foreign-host transition-lock owner",
    );

    await rm(transitionEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
    const malformedTimestampOwner = {
      ...liveOwner,
      token: randomUUID(),
      createdAt: "not-a-timestamp",
    };
    await writeStaleTransitionLock(malformedTimestampOwner);
    let malformedTimestampOwnerError;
    try {
      await acquireTransitionLock(transitionEntry, { waitTimeoutMs: 250 });
    } catch (error) {
      malformedTimestampOwnerError = error;
    }
    if (
      !malformedTimestampOwnerError?.message.includes(
        "Timed out waiting for API typecheck regression transition lock",
      ) ||
      !malformedTimestampOwnerError.message.includes(
        "owner age: unavailable (missing or invalid createdAt)",
      ) ||
      malformedTimestampOwnerError.message.includes(
        malformedTimestampOwner.token,
      )
    ) {
      throw (
        malformedTimestampOwnerError ??
        new Error(
          "Malformed-timestamp transition-lock owner was unexpectedly reclaimed",
        )
      );
    }
    const currentMalformedOwner = await readJson(
      transitionEntry.transitionOwnerPath,
    ).catch(() => null);
    if (currentMalformedOwner?.token !== malformedTimestampOwner.token) {
      throw new Error(
        "Malformed-timestamp transition-lock owner was reclaimed or replaced",
      );
    }

    const malformedOwnerCases = [
      {
        owner: (() => {
          const owner = { ...liveOwner, token: randomUUID() };
          delete owner.pid;
          return owner;
        })(),
        description: "Missing-PID transition-lock owner",
      },
      {
        owner: {
          ...liveOwner,
          token: randomUUID(),
          pid: 0,
        },
        description: "Invalid-PID transition-lock owner",
      },
      {
        owner: (() => {
          const owner = { ...liveOwner, token: randomUUID() };
          delete owner.hostname;
          return owner;
        })(),
        description: "Missing-hostname transition-lock owner",
      },
      {
        owner: {
          ...liveOwner,
          token: randomUUID(),
          hostname: "",
        },
        description: "Invalid-hostname transition-lock owner",
      },
      ...invalidProcessIdentityValues.map((processIdentity, index) => ({
        owner: { ...liveOwner, token: randomUUID(), processIdentity },
        description: `Invalid-process-identity transition-lock owner (${index})`,
      })),
    ];
    for (const { owner, description } of malformedOwnerCases) {
      phase = `owner-observed-${description}`;
      await rm(transitionEntry.transitionLockDirectory, {
        force: true,
        recursive: true,
      });
      await writeStaleTransitionLock(owner);
      const before = await fingerprint(transitionEntry.transitionLockDirectory);
      let malformedOwnerError;
      try {
        await acquireTransitionLock(transitionEntry, { waitTimeoutMs: 250 });
      } catch (error) {
        malformedOwnerError = error;
      }
      if (
        !malformedOwnerError?.message.includes(
          "Timed out waiting for API typecheck regression transition lock",
        ) ||
        !malformedOwnerError.message.includes(
          `canonical output ${transitionEntry.canonicalPath}`,
        ) ||
        !malformedOwnerError.message.includes("status: malformed") ||
        malformedOwnerError.lockDiagnostic?.ownerStatus !== "malformed" ||
        /reused|PID[- ]reuse/i.test(
          `${malformedOwnerError.message} ${JSON.stringify(malformedOwnerError.lockDiagnostics)}`,
        ) ||
        malformedOwnerError.message.includes(owner.token)
      ) {
        throw (
          malformedOwnerError ??
          new Error(`${description} was unexpectedly reclaimed`)
        );
      }
      if (!(await exists(transitionEntry.transitionLockDirectory))) {
        throw new Error(`${description} lock directory was reclaimed`);
      }
      const currentOwner = await readJson(
        transitionEntry.transitionOwnerPath,
      ).catch(() => null);
      if (currentOwner?.token !== owner.token) {
        throw new Error(`${description} was reclaimed or replaced`);
      }
      if (
        JSON.stringify(await fingerprint(transitionEntry.transitionLockDirectory)) !==
        JSON.stringify(before)
      ) {
        throw new Error(`${description} lock contents changed after timeout`);
      }
      if (owner.pid === process.pid && !processExists(owner.pid)) {
        throw new Error(`${description} live recorded process did not survive`);
      }
    }

    const unreadableOwnerCases = [
      {
        ownerContents: null,
        description: "Missing-owner transition lock",
        expectedIssue: "owner record is unreadable (owner file is missing)",
      },
      {
        ownerContents: "{ invalid json\n",
        description: "Invalid-JSON transition-lock owner",
        expectedIssue: "owner record is malformed (invalid JSON)",
      },
    ];
    for (const {
      ownerContents,
      description,
      expectedIssue,
    } of unreadableOwnerCases) {
      phase = `owner-observed-${description}`;
      await rm(transitionEntry.transitionLockDirectory, {
        force: true,
        recursive: true,
      });
      await writeStaleTransitionLockContents(ownerContents);

      let unreadableOwnerError;
      try {
        await acquireTransitionLock(transitionEntry, { waitTimeoutMs: 250 });
      } catch (error) {
        unreadableOwnerError = error;
      }
      if (
        !unreadableOwnerError?.message.includes(
          "Timed out waiting for API typecheck regression transition lock",
        ) ||
        !unreadableOwnerError.message.includes(
          `canonical output ${transitionEntry.canonicalPath}`,
        ) ||
        !unreadableOwnerError.message.includes(expectedIssue)
      ) {
        throw (
          unreadableOwnerError ??
          new Error(`${description} was unexpectedly reclaimed`)
        );
      }
      if (!(await exists(transitionEntry.transitionLockDirectory))) {
        throw new Error(`${description} lock directory was reclaimed`);
      }
      if (ownerContents === null) {
        if (await exists(transitionEntry.transitionOwnerPath)) {
          throw new Error(`${description} unexpectedly gained an owner file`);
        }
      } else if (
        (await readFile(transitionEntry.transitionOwnerPath, "utf8")) !==
        ownerContents
      ) {
        throw new Error(`${description} owner record changed after timeout`);
      }
    }

    await testOwnerFilesystemReadFailures(transitionEntry, { transition: true });
    await testNullLockOwner(transitionEntry, { transition: true });

    phase = "stale-takeover-rename-failure";
    await rm(transitionEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
    await writeStaleTransitionLock(deadOwner);
    const originalOwnerBytes = await readFile(transitionEntry.transitionOwnerPath);
    const originalLockStats = await stat(transitionEntry.transitionLockDirectory);
    const originalLockEntries = await readdir(transitionEntry.transitionLockDirectory);
    const renameFailure = Object.assign(
      new Error("Injected stale transition-lock rename failure (EACCES)"),
      { code: "EACCES" },
    );
    let renameAttempts = 0;
    let failedStaleDirectory;
    let renameError;
    try {
      await acquireTransitionLock(transitionEntry, {
        waitTimeoutMs: 250,
        renameStaleDirectory: async (source, destination) => {
          renameAttempts += 1;
          if (
            source !== transitionEntry.transitionLockDirectory ||
            !destination.startsWith(`${source}.stale-`)
          ) {
            throw new Error("Rename failure fixture intercepted the wrong move");
          }
          failedStaleDirectory = destination;
          throw renameFailure;
        },
      });
    } catch (error) {
      renameError = error;
    }
    const diagnostic = renameError?.lockDiagnostic;
    if (
      renameAttempts !== 1 ||
      !renameError?.message.includes(renameFailure.message) ||
      !renameError.message.includes("phase: stale-takeover-rename") ||
      !renameError.message.includes(`canonical output ${transitionEntry.canonicalPath}`) ||
      !renameError.message.includes("recorded owner status: dead") ||
      !renameError.message.includes("lock directory remained: yes") ||
      !renameError.message.includes("owner file remained: yes") ||
      renameError.message.includes(deadOwner.token) ||
      diagnostic?.phase !== "stale-takeover-rename" ||
      diagnostic.canonicalOutput !== transitionEntry.canonicalPath ||
      diagnostic.ownerStatus !== "dead" ||
      diagnostic.transition !== true ||
      diagnostic.filesystemState?.lockDirectory?.remains !== true ||
      diagnostic.filesystemState?.ownerFile?.remains !== true
    ) {
      throw new Error("Initial stale-lock rename failure lost its diagnostic", {
        cause: renameError,
      });
    }
    const remainingLockStats = await stat(transitionEntry.transitionLockDirectory);
    if (
      !(await readFile(transitionEntry.transitionOwnerPath)).equals(originalOwnerBytes) ||
      remainingLockStats.dev !== originalLockStats.dev ||
      remainingLockStats.ino !== originalLockStats.ino ||
      remainingLockStats.mtimeMs !== originalLockStats.mtimeMs ||
      JSON.stringify(await readdir(transitionEntry.transitionLockDirectory)) !==
        JSON.stringify(originalLockEntries) ||
      (await exists(failedStaleDirectory))
    ) {
      throw new Error("Failed initial stale-lock rename changed the original lock or owner");
    }
    console.log("Initial stale-lock rename failure preserves the original lock and owner with a dead-owner diagnostic.");

    for (const installReplacement of [false, true]) {
      phase = "stale-takeover-cleanup-failure";
      await rm(transitionEntry.transitionLockDirectory, {
        force: true,
        recursive: true,
      });
      await writeStaleTransitionLock(deadOwner);
      const staleOwnerBytes = await readFile(transitionEntry.transitionOwnerPath);
      const cleanupFailure = Object.assign(
        new Error("Injected stale transition-lock cleanup failure (EACCES)"),
        { code: "EACCES" },
      );
      let staleDirectory;
      let cleanupAttempts = 0;
      let cleanupError;
      let retryOwner;
      try {
        try {
          await acquireTransitionLock(transitionEntry, {
            waitTimeoutMs: 250,
            removeStaleDirectory: async (directory, options) => {
              cleanupAttempts += 1;
              staleDirectory = directory;
              if (
                !directory.startsWith(`${transitionEntry.transitionLockDirectory}.stale-`) ||
                options.force !== true ||
                options.recursive !== true ||
                (await readJson(path.join(directory, "owner.json"))).token !== deadOwner.token ||
                (await exists(transitionEntry.transitionLockDirectory))
              ) {
                throw new Error("Cleanup fixture intercepted an unverified stale lock");
              }
              if (installReplacement) {
                await writeStaleTransitionLock(liveOwner);
              }
              throw cleanupFailure;
            },
          });
        } catch (error) {
          cleanupError = error;
        }
        const cleanupDiagnostic = cleanupError?.lockDiagnostic;
        const expectedStatus = installReplacement ? "live" : "unavailable";
        const remained = installReplacement ? "yes" : "no";
        if (
          cleanupAttempts !== 1 ||
          cleanupError?.cause !== cleanupFailure ||
          !cleanupError.message.includes(cleanupFailure.message) ||
          !cleanupError.message.includes("phase: stale-takeover-cleanup") ||
          !cleanupError.message.includes(`canonical output ${transitionEntry.canonicalPath}`) ||
          !cleanupError.message.includes(`recorded owner status: ${expectedStatus}`) ||
          !cleanupError.message.includes(`lock directory remained: ${remained}`) ||
          !cleanupError.message.includes(`owner file remained: ${remained}`) ||
          cleanupError.message.includes(deadOwner.token) ||
          cleanupError.message.includes(liveOwner.token) ||
          cleanupDiagnostic?.phase !== "stale-takeover-cleanup" ||
          cleanupDiagnostic.canonicalOutput !== transitionEntry.canonicalPath ||
          cleanupDiagnostic.transition !== true ||
          cleanupDiagnostic.ownerStatus !== expectedStatus ||
          cleanupDiagnostic.filesystemState?.lockDirectory?.path !== transitionEntry.transitionLockDirectory ||
          cleanupDiagnostic.filesystemState?.ownerFile?.path !== transitionEntry.transitionOwnerPath ||
          cleanupDiagnostic.filesystemState?.lockDirectory?.remains !== installReplacement ||
          cleanupDiagnostic.filesystemState?.ownerFile?.remains !== installReplacement
        ) {
          throw new Error("Stale-lock cleanup failure lost its diagnostic", {
            cause: cleanupError,
          });
        }
        if (
          !(await readFile(path.join(staleDirectory, "owner.json"))).equals(staleOwnerBytes)
        ) {
          throw new Error("Failed stale cleanup changed the moved owner");
        }
        if (installReplacement) {
          const replacementBytes = await readFile(transitionEntry.transitionOwnerPath);
          await assertTransitionOwnerRemains(liveOwner, "Cleanup-failure replacement owner");
          if (!(await readFile(transitionEntry.transitionOwnerPath)).equals(replacementBytes)) {
            throw new Error("Retry after cleanup failure overwrote the replacement owner");
          }
          await releaseTransitionLock(liveOwner, transitionEntry);
        }
        retryOwner = await acquireTransitionLock(transitionEntry, { waitTimeoutMs: 250 });
        if (
          retryOwner.token === deadOwner.token ||
          retryOwner.token === liveOwner.token ||
          (await readJson(transitionEntry.transitionOwnerPath)).token !== retryOwner.token ||
          !(await readFile(path.join(staleDirectory, "owner.json"))).equals(staleOwnerBytes)
        ) {
          throw new Error("Retry after cleanup failure did not safely acquire a fresh lock");
        }
        await releaseTransitionLock(retryOwner, transitionEntry);
        if (await exists(transitionEntry.transitionLockDirectory)) {
          throw new Error("Retry after cleanup failure left the acquired lock behind");
        }
      } finally {
        if (retryOwner) await releaseTransitionLock(retryOwner, transitionEntry);
        if (staleDirectory) {
          await rm(staleDirectory, { force: true, recursive: true });
        }
      }
    }
    console.log("Verified stale-lock cleanup failures report remaining state; retries acquire free locks and preserve live replacement owners.");

    const replacementOwnerRaceIterations = 3;
    const simultaneousContenderCount = 5;
    const raceContext = `host=${process.env.API_TYPECHECK_NATIVE_TEST_HOST ?? process.platform} runtime=${process.version} platform=${process.platform}`;
    for (
      let raceIteration = 1;
      raceIteration <= replacementOwnerRaceIterations;
      raceIteration += 1
    ) {
      const raceLabel = `[${raceContext}] replacement-owner race iteration ${raceIteration}/${replacementOwnerRaceIterations}`;
      phase = `stale-takeover-competing-rename-race ${raceLabel}`;
      const iterationDeadOwner = { ...deadOwner, token: randomUUID() };
      await rm(transitionEntry.transitionLockDirectory, {
        force: true,
        recursive: true,
      });
      await writeStaleTransitionLock(iterationDeadOwner);
      let replacementOwnerDirectory;
      let replacementOwnerChild;
      let replacementOwnerToken;
      let replacementStaleDirectory;
      try {
        replacementOwnerDirectory = await mkdtemp(
          path.join(os.tmpdir(), "api-typecheck-transition-lock-replacement-"),
        );
        const replacementOwnerReadyPath = path.join(
          replacementOwnerDirectory,
          "ready",
        );
        let raceError;
        try {
          await acquireTransitionLock(transitionEntry, {
            waitTimeoutMs: 500,
            onStaleTakeoverMoved: async ({ staleDirectory }) => {
              replacementStaleDirectory = staleDirectory;
              replacementOwnerChild = spawn(
                process.execPath,
                [
                  fileURLToPath(import.meta.url),
                  "--run-transition-lock-owner-replacement-fixture",
                ],
                {
                  cwd: workspaceRoot,
                  env: {
                    ...process.env,
                    API_TYPECHECK_TRANSITION_LOCK_DIRECTORY:
                      transitionEntry.transitionLockDirectory,
                    API_TYPECHECK_TRANSITION_STALE_DIRECTORY: staleDirectory,
                    API_TYPECHECK_TRANSITION_OWNER_PATH: path.join(
                      transitionEntry.transitionLockDirectory,
                      "owner.json",
                    ),
                    API_TYPECHECK_TRANSITION_READY_PATH:
                      replacementOwnerReadyPath,
                    API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
                  },
                  stdio: "inherit",
                },
              );
              await waitForFile(
                replacementOwnerReadyPath,
                replacementOwnerChild,
              );
              replacementOwnerToken = (
                await readFile(replacementOwnerReadyPath, "utf8")
              ).trim();
            },
          });
        } catch (error) {
          raceError = error;
          raceError.message = `${raceError.message} (${raceLabel})`;
        }
        if (
          !raceError?.message.includes(
            "Transition-lock handoff failed (phase: stale-takeover-rename-race)",
          ) ||
          !raceError.message.includes(
            `canonical output ${transitionEntry.canonicalPath}`,
          ) ||
          !raceError.message.includes("recorded owner status: live") ||
          !raceError.message.includes("lock directory remained: yes") ||
          !raceError.message.includes("owner file remained: yes") ||
          !replacementOwnerToken ||
          raceError.message.includes(iterationDeadOwner.token)
        ) {
          throw (
            raceError ??
            new Error(
              `${raceLabel}: competing stale transition-lock rename unexpectedly succeeded`,
            )
          );
        }
        const replacementOwner = await readJson(
          transitionEntry.transitionOwnerPath,
        ).catch(() => null);
        if (
          replacementOwner?.token !== replacementOwnerToken ||
          replacementOwner?.token === iterationDeadOwner.token ||
          !(await exists(transitionEntry.transitionLockDirectory)) ||
          (await exists(replacementStaleDirectory))
        ) {
          throw new Error(
            `${raceLabel}: competing stale transition-lock owner was reclaimed during the rename race`,
          );
        }
        let replacementOwnerTimeout;
        try {
          await acquireTransitionLock(transitionEntry, { waitTimeoutMs: 250 });
        } catch (error) {
          replacementOwnerTimeout = error;
        }
        if (
          !replacementOwnerTimeout?.message.includes(
            "Timed out waiting for API typecheck regression transition lock",
          ) ||
          !replacementOwnerTimeout.message.includes(
            `owner PID: ${replacementOwner.pid}`,
          ) ||
          !replacementOwnerTimeout.message.includes("status: live") ||
          replacementOwnerTimeout.message.includes(replacementOwnerToken)
        ) {
          throw (
            replacementOwnerTimeout ??
            new Error(
              `${raceLabel}: a later transition-lock contender did not time out on the live replacement owner`,
            )
          );
        }
        const ownerAfterTimeout = await readJson(
          transitionEntry.transitionOwnerPath,
        ).catch(() => null);
        if (
          ownerAfterTimeout?.token !== replacementOwnerToken ||
          !(await exists(transitionEntry.transitionLockDirectory)) ||
          (await exists(replacementStaleDirectory))
        ) {
          throw new Error(
            `${raceLabel}: a later contender changed or reclaimed the live replacement owner`,
          );
        }

        phase = `simultaneous-contenders ${raceLabel}`;
        const ownerBytesBefore = await readFile(transitionEntry.transitionOwnerPath);
        const directoryBefore = await stat(transitionEntry.transitionLockDirectory);
        const ownerFileBefore = await stat(transitionEntry.transitionOwnerPath);
        const entriesBefore = await readdir(transitionEntry.transitionLockDirectory);
        const observedLiveOwner = new Set();
        // Start the whole group without awaiting an individual contender. Drain
        // every attempt before assertions/fixture cleanup, even if one acquires.
        const results = await Promise.allSettled(
          Array.from({ length: simultaneousContenderCount }, (_, index) =>
            acquireTransitionLock(transitionEntry, {
              waitTimeoutMs: 250,
              onOwnerStatus: ({ owner, status }) => {
                if (
                  status !== "live" ||
                  owner?.pid !== replacementOwner.pid ||
                  owner?.token !== replacementOwnerToken
                ) {
                  throw new Error(
                    `${raceLabel}: simultaneous contender ${index + 1} did not observe the live replacement owner`,
                  );
                }
                observedLiveOwner.add(index);
              },
            }),
          ),
        );
        for (const [index, result] of results.entries()) {
          const error = result.status === "rejected" ? result.reason : null;
          if (
            !observedLiveOwner.has(index) ||
            !error?.message.includes(
              "Timed out waiting for API typecheck regression transition lock",
            ) ||
            !error.message.includes(`owner PID: ${replacementOwner.pid}`) ||
            !error.message.includes("status: live") ||
            error.message.includes(replacementOwnerToken) ||
            error.lockDiagnostic?.ownerStatus !== "live" ||
            error.lockDiagnostic?.transition !== true
          ) {
            throw new Error(
              `${raceLabel}: simultaneous contender ${index + 1}/${simultaneousContenderCount} did not time out on the live replacement owner`,
              { cause: error },
            );
          }
        }
        const directoryAfter = await stat(transitionEntry.transitionLockDirectory);
        const ownerFileAfter = await stat(transitionEntry.transitionOwnerPath);
        if (
          !(await readFile(transitionEntry.transitionOwnerPath)).equals(ownerBytesBefore) ||
          [directoryBefore, ownerFileBefore].some((before, index) => {
            const after = [directoryAfter, ownerFileAfter][index];
            return before.dev !== after.dev ||
              before.ino !== after.ino ||
              before.mtimeMs !== after.mtimeMs ||
              before.ctimeMs !== after.ctimeMs;
          }) ||
          JSON.stringify(await readdir(transitionEntry.transitionLockDirectory)) !==
            JSON.stringify(entriesBefore) ||
          (await exists(replacementStaleDirectory))
        ) {
          throw new Error(
            `${raceLabel}: simultaneous contenders changed the replacement lock directory or owner record`,
          );
        }
        console.log(
          `${raceLabel}: live replacement owner survived a later contender and ${simultaneousContenderCount} simultaneous contenders without changes.`,
        );
      } finally {
        if (
          replacementOwnerChild &&
          replacementOwnerChild.exitCode === null &&
          replacementOwnerChild.signalCode === null
        ) {
          replacementOwnerChild.kill();
          await new Promise((resolve) =>
            replacementOwnerChild.once("exit", resolve),
          );
        }
        if (replacementStaleDirectory) {
          await rm(replacementStaleDirectory, {
            force: true,
            recursive: true,
          });
          if (await exists(replacementStaleDirectory)) {
            throw new Error(
              `${raceLabel}: stale transition-lock directory remained after cleanup`,
            );
          }
        }
        if (replacementOwnerDirectory) {
          await rm(replacementOwnerDirectory, {
            force: true,
            recursive: true,
          });
        }
      }
    }
    console.log(
      `Transition-lock replacement-owner race passed ${replacementOwnerRaceIterations} iterations; each replacement owner blocked a later contender and ${simultaneousContenderCount} simultaneous contenders without changes.`,
    );

    await rm(transitionEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
    await writeStaleTransitionLock(deadOwner);
    const acquiredOwner = await acquireTransitionLock(transitionEntry, {
      waitTimeoutMs: 250,
    });
    if (
      acquiredOwner.token === deadOwner.token ||
      (await readJson(transitionEntry.transitionOwnerPath)).token !==
        acquiredOwner.token
    ) {
      throw new Error("Dead transition-lock owner was not reclaimed");
    }
    phase = "transition-lock-release";
    await releaseTransitionLock(acquiredOwner, transitionEntry);
    if (await exists(transitionEntry.transitionLockDirectory)) {
      throw new Error(
        "Transition lock remained after dead-owner takeover release",
      );
    }
  } catch (error) {
    throw await createLockDiagnosticError(error, transitionEntry, {
      phase,
      transition: true,
    });
  } finally {
    await rm(transitionEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
    await rm(testDirectory, { force: true, recursive: true });
  }
}

async function testNativeTransitionLockOwnerExitIteration(platform, signal) {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "api-typecheck-transition-lock-native-exit-"),
  );
  const readyPath = path.join(testDirectory, "ready");
  const lockEntry = createLockEntry(
    path.join(testDirectory, "transition-output"),
  );
  let ownerChild;
  let contender;
  let acquiredOwner;
  let contenderReleased = false;
  let phase = "transition-lock-owner-fixture-setup";

  try {
    signal?.throwIfAborted();
    phase = "owner-fixture-startup";
    ownerChild = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--run-transition-lock-owner-fixture"],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          API_TYPECHECK_TRANSITION_LOCK_DIRECTORY:
            lockEntry.transitionLockDirectory,
          API_TYPECHECK_TRANSITION_OWNER_PATH: lockEntry.transitionOwnerPath,
          API_TYPECHECK_TRANSITION_READY_PATH: readyPath,
          API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );

    const readyDeadline = Date.now() + 30_000;
    phase = "owner-fixture-ready";
    while (!(await exists(readyPath))) {
      signal?.throwIfAborted();
      if (ownerChild.exitCode !== null || ownerChild.signalCode !== null) {
        throw new Error(
          "Native transition-lock owner fixture exited before becoming ready",
        );
      }
      if (Date.now() > readyDeadline) {
        throw new Error(
          "Timed out waiting for native transition-lock owner fixture",
        );
      }
      await sleep(25);
    }
    signal?.throwIfAborted();

    let resolveLiveObservation;
    let rejectLiveObservation;
    const liveObservation = new Promise((resolve, reject) => {
      resolveLiveObservation = resolve;
      rejectLiveObservation = reject;
    });
    contender = acquireTransitionLock(lockEntry, {
      waitTimeoutMs: 5_000,
      onOwnerStatus: async ({ owner, status }) => {
        if (status !== "live") return;
        phase = "owner-observed-live";
        const currentOwner = await readJson(
          lockEntry.transitionOwnerPath,
        ).catch(() => null);
        if (
          currentOwner?.token !== owner.token ||
          !(await exists(lockEntry.transitionLockDirectory))
        ) {
          throw new Error(
            "Native transition contender observed a live owner after the lock changed",
          );
        }
        resolveLiveObservation();
      },
    });
    contender.then(() => {}, rejectLiveObservation);
    await liveObservation;
    if (runNativeTransitionInterruptionFixture) {
      // Pause with a real owner and contender, not a synthetic lock. The IPC
      // handle keeps this fixture alive until its parent interrupts it.
      process.send({
        ownerPid: ownerChild.pid,
        testDirectory,
        transitionDirectory: lockEntry.transitionLockDirectory,
        ownerPath: lockEntry.transitionOwnerPath,
      });
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
    }
    signal?.throwIfAborted();

    phase = "owner-exit";
    if (!ownerChild.kill()) {
      throw new Error(
        `Could not terminate native transition-lock owner child ${ownerChild.pid}`,
      );
    }
    await new Promise((resolve, reject) => {
      ownerChild.once("error", reject);
      ownerChild.once("exit", resolve);
    });

    phase = "stale-takeover-after-owner-exit";
    acquiredOwner = await contender;
    const currentOwner = await readJson(lockEntry.transitionOwnerPath);
    if (
      currentOwner.token !== acquiredOwner.token ||
      currentOwner.pid !== process.pid ||
      !currentOwner.processIdentity?.startsWith(`${platform}:`)
    ) {
      throw new Error(
        "Native transition contender did not reclaim the lock after its owner exited",
      );
    }
    phase = "transition-lock-release";
    await releaseTransitionLock(acquiredOwner, lockEntry);
    contenderReleased = true;
    if (
      (await exists(lockEntry.transitionLockDirectory)) ||
      (await exists(lockEntry.transitionOwnerPath))
    ) {
      throw new Error(
        "Native transition lock or owner file remained after exit-race takeover release",
      );
    }
  } catch (error) {
    throw await createLockDiagnosticError(error, lockEntry, {
      phase,
      transition: true,
    });
  } finally {
    try {
      if (
        ownerChild &&
        ownerChild.exitCode === null &&
        ownerChild.signalCode === null
      ) {
        const childExit = new Promise((resolve, reject) => {
          if (ownerChild.exitCode !== null || ownerChild.signalCode !== null) {
            resolve();
            return;
          }
          ownerChild.once("error", reject);
          ownerChild.once("exit", resolve);
        });
        ownerChild.kill();
        await childExit;
      }
    } finally {
      try {
        if (contender && !contenderReleased) {
          try {
            acquiredOwner ??= await contender;
            if (acquiredOwner) {
              await releaseTransitionLock(acquiredOwner, lockEntry);
              contenderReleased = true;
            }
          } catch {
            // The iteration failure is reported above; remove any lock state
            // left by a contender that could not be released.
          }
        }
      } finally {
        try {
          await rm(lockEntry.transitionLockDirectory, {
            force: true,
            recursive: true,
          });
        } finally {
          try {
            await rm(lockEntry.transitionOwnerPath, { force: true });
          } finally {
            await rm(testDirectory, { force: true, recursive: true });
          }
        }
      }
    }
  }
}

async function testNativeTransitionLockOwnerExit(signal) {
  const rawIterationCount =
    process.env.API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS ?? "1";
  if (!/^[1-9]\d*$/.test(rawIterationCount)) {
    throw new Error(
      "API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS must be an integer between 1 and 10",
    );
  }
  const iterationCount = Number(rawIterationCount);
  if (iterationCount > 10) {
    throw new Error(
      "API_TYPECHECK_NATIVE_TRANSITION_EXIT_ITERATIONS must be an integer between 1 and 10",
    );
  }

  const platform = process.platform;
  if (!["darwin", "win32"].includes(platform)) {
    throw new Error(
      `Native transition-lock owner exit recovery requires macOS or Windows; received ${platform}`,
    );
  }

  for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
    try {
      signal.throwIfAborted();
      await testNativeTransitionLockOwnerExitIteration(platform, signal);
    } catch (error) {
      throw new Error(
        `Native transition-lock owner exit recovery iteration ${iteration}/${iterationCount} failed: ${error.message}`,
        { cause: error },
      );
    }
    console.log(
      `Native transition-lock owner exit recovery iteration ${iteration}/${iterationCount} passed.`,
    );
  }

  return iterationCount;
}

if (testProcessIdentity) {
  testLockOwnerAgeFormatting();

  for (const processIdentity of [
    undefined, null, "456789", "linux:456789",
    "darwin:Tue Sep  8 12:34:56 2026", "win32:638929028960000000",
    "opaque future identity",
  ]) {
    const owner = { pid: 123, hostname: "test-host", processIdentity };
    const status = await getOwnerStatusDetails(owner, {
      hostname: "test-host",
      exists: () => true,
      getIdentity: async () => processIdentity ?? "current-identity",
    });
    const expected = processIdentity == null ? "metadata-unavailable" : "live";
    if (getOwnerRecordValidationError(owner) !== null || status !== expected) {
      throw new Error(`Valid optional process identity rejected: ${JSON.stringify(processIdentity)}`);
    }
  }
  for (const processIdentity of invalidProcessIdentityValues) {
    const owner = { pid: 123, hostname: "test-host", processIdentity };
    const status = await getOwnerStatusDetails(owner, {
      hostname: "test-host",
      exists: () => { throw new Error("Malformed identity reached PID probe"); },
      getIdentity: async () => { throw new Error("Malformed identity reached identity probe"); },
    });
    if (
      getOwnerRecordValidationError(owner) !== "recorded owner process identity is invalid" ||
      status !== "malformed"
    ) {
      throw new Error(`Invalid process identity accepted: ${JSON.stringify(processIdentity)}`);
    }
  }

  const commandCases = [
    {
      platform: "darwin",
      probe: "ps",
      stdout: "Tue Sep  8 12:34:56 2026\n",
      expected: "darwin:Tue Sep  8 12:34:56 2026",
    },
    {
      platform: "win32",
      probe: "PowerShell",
      stdout: "638929028960000000\r\n",
      expected: "win32:638929028960000000",
    },
  ];
  for (const testCase of commandCases) {
    let commandOptions;
    const identity = await readProcessIdentityCommand(
      123,
      testCase.platform,
      (_command, _args, options) => {
        commandOptions = options;
        return {
          status: 0,
          stdout: testCase.stdout,
        };
      },
    );
    if (identity !== testCase.expected) {
      throw new Error(`${testCase.platform} process identity was not parsed`);
    }
    if (commandOptions?.timeout !== processIdentityCommandTimeoutMs) {
      throw new Error(
        `${testCase.platform} ${testCase.probe} process identity probe has no bounded timeout`,
      );
    }
    const timedOutIdentity = await readProcessIdentityCommand(
      123,
      testCase.platform,
      () => ({
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        status: null,
        signal: "SIGTERM",
        stdout: "",
      }),
    );
    if (timedOutIdentity !== null) {
      throw new Error(
        `${testCase.platform} ${testCase.probe} timeout did not use the metadata-unavailable fallback`,
      );
    }
    const timedOutOwner = {
      hostname: "test-host",
      pid: 123,
      processIdentity: identity,
    };
    if (
      !(await isOwnerAlive(timedOutOwner, {
        platform: testCase.platform,
        hostname: "test-host",
        getIdentity: async () => timedOutIdentity,
        exists: () => true,
      }))
    ) {
      throw new Error(
        `${testCase.platform} ${testCase.probe} timeout treated a live owner as dead`,
      );
    }
    const owner = {
      hostname: "test-host",
      pid: 123,
      processIdentity: identity,
    };
    if (
      !(await isOwnerAlive(owner, {
        platform: testCase.platform,
        hostname: "test-host",
        getIdentity: async () => identity,
        exists: () => true,
      }))
    ) {
      throw new Error(`${testCase.platform} live owner was treated as dead`);
    }
    if (
      await isOwnerAlive(owner, {
        platform: testCase.platform,
        hostname: "test-host",
        getIdentity: async () => identity,
        exists: () => false,
      })
    ) {
      throw new Error(`${testCase.platform} dead owner was treated as live`);
    }
    if (
      await isOwnerAlive(owner, {
        platform: testCase.platform,
        hostname: "test-host",
        getIdentity: async () => `${identity}-replacement`,
        exists: () => true,
      })
    ) {
      throw new Error(`${testCase.platform} reused PID was treated as owner`);
    }
  }
  const legacyLinuxOwner = {
    hostname: "test-host",
    pid: 123,
    processIdentity: "456789",
  };
  if (
    !(await isOwnerAlive(legacyLinuxOwner, {
      platform: "linux",
      hostname: "test-host",
      getIdentity: async () => "456789",
      exists: () => true,
    }))
  ) {
    throw new Error("Legacy Linux owner identity was treated as dead");
  }
  if (
    !(await isOwnerAlive(legacyLinuxOwner, {
      platform: "linux",
      hostname: "test-host",
      getIdentity: async () => null,
      exists: () => true,
    }))
  ) {
    throw new Error(
      "Live owner was treated as dead when identity was unavailable",
    );
  }
  await testPerPathLockTakeover();
  await testTransitionLockTakeover();
  console.log(
    "Platform process identities distinguish live, dead, replaced, legacy, and metadata-unavailable lock owners; per-path and transition stale takeover preserve live and replaced owners while reclaiming dead ones.",
  );
  process.exit(0);
}

if (testNativeProcessIdentity) {
  const platform = process.platform;
  const failureContext = `host=${process.env.API_TYPECHECK_NATIVE_TEST_HOST ?? platform} runtime=${process.version} platform=${platform}`;
  let phase = "identity";
  await exposeNativeProcessProbePhase(phase);
  const probe =
    platform === "darwin"
      ? "ps -o lstart="
      : platform === "win32"
        ? "PowerShell Get-Process StartTime"
        : null;
  if (!probe) {
    throw new Error(
      `[${failureContext}] Native process identity probe is only supported on macOS and Windows`,
    );
  }

  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { stdio: "ignore", windowsHide: true },
  );
  const childExit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    const identityDeadline = Date.now() + 5_000;
    let identity = null;
    while (!identity && Date.now() < identityDeadline) {
      identity = await getProcessIdentity(child.pid);
      if (!identity) await sleep(50);
    }
    if (!identity) {
      throw new Error(
        `[${failureContext}] ${probe} identity probe returned no identity for live child ${child.pid}`,
      );
    }
    const owner = {
      hostname: os.hostname(),
      pid: child.pid,
      processIdentity: identity,
    };
    if (!(await isOwnerAlive(owner))) {
      throw new Error(
        `[${failureContext}] ${probe} identity probe did not recognize live child ${child.pid}`,
      );
    }

    if (!child.kill()) {
      throw new Error(
        `[${failureContext}] ${probe} identity probe test could not terminate child ${child.pid}`,
      );
    }
    await childExit;

    if (await isOwnerAlive(owner)) {
      throw new Error(
        `[${failureContext}] ${probe} identity probe treated terminated child ${child.pid} as a live lock owner`,
      );
    }

    const staleTimestamp = new Date(
      Date.now() - Math.max(lockStaleAfterMs, 30_000) - 1_000,
    );
    const staleLockOwner = {
      ...owner,
      token: randomUUID(),
      createdAt: staleTimestamp.toISOString(),
      paths: lockedPaths,
    };
    const staleTransitionOwner = {
      ...owner,
      token: randomUUID(),
      createdAt: staleTimestamp.toISOString(),
    };
    let acquiredOwner = null;
    try {
      phase = "filesystem-setup";
      await exposeNativeProcessProbePhase(phase);
      await mkdir(lockDirectory);
      await writeFile(lockOwnerPath, `${JSON.stringify(staleLockOwner)}\n`, {
        flag: "wx",
      });
      await mkdir(transitionLockDirectory);
      await writeFile(
        transitionOwnerPath,
        `${JSON.stringify(staleTransitionOwner)}\n`,
        { flag: "wx" },
      );
      await Promise.all([
        utimes(lockDirectory, staleTimestamp, staleTimestamp),
        utimes(transitionLockDirectory, staleTimestamp, staleTimestamp),
      ]);

      phase = "transition-locking";
      await exposeNativeProcessProbePhase(phase);
      acquiredOwner = await acquireLock();
      const currentOwner = await readJson(lockOwnerPath);
      if (
        currentOwner.token !== acquiredOwner.token ||
        currentOwner.token === staleLockOwner.token
      ) {
        throw new Error("stale lock owner was not replaced by the new process");
      }
      if (await exists(transitionLockDirectory)) {
        throw new Error("transition lock remained after stale-lock takeover");
      }

      phase = "filesystem-cleanup";
      await exposeNativeProcessProbePhase(phase);
      await releaseLock(acquiredOwner);
      acquiredOwner = null;
      if (
        (await exists(lockDirectory)) ||
        (await exists(transitionLockDirectory))
      ) {
        throw new Error("lock directories remained after takeover release");
      }
    } catch (error) {
      throw new Error(
        `[${failureContext}] stale lock takeover failed during ${phase}: ${error.message}`,
        { cause: error },
      );
    } finally {
      if (acquiredOwner) {
        await releaseLock(acquiredOwner).catch(() => {});
      }
      await Promise.all([
        rm(lockDirectory, { force: true, recursive: true }),
        rm(transitionLockDirectory, { force: true, recursive: true }),
      ]);
    }

    console.log(
      `[${failureContext}] ${probe} identity probe recognized a live child; transition locking reclaimed its stale lock and filesystem cleanup completed after takeover.`,
    );
    phase = "transition-locking";
    await exposeNativeProcessProbePhase(phase);
    try {
      await testTransitionLockTakeover();
    } catch (error) {
      throw new Error(
        `[${failureContext}] native transition-lock replacement race failed during ${phase}: ${error.message}`,
        { cause: error },
      );
    }
    console.log(
      `[${failureContext}] transition-lock replacement race preserved the replacement owner, and a later contender timed out while that owner remained live.`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await childExit.catch(() => {});
    }
  }
  process.exit(0);
}

if (testNativeTransitionLockOwnerExitProbe || runNativeTransitionInterruptionFixture) {
  const controller = new AbortController();
  let interruption;
  const interrupt = (signal) => {
    if (interruption) return;
    interruption = signal;
    controller.abort(new Error(`Native transition probe interrupted by ${signal}`));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  // Windows process.kill() forcibly terminates Node without running signal
  // listeners. Exercise the same listeners via IPC only in the test fixture.
  if (runNativeTransitionInterruptionFixture && process.platform === "win32") {
    process.on("message", (signal) => {
      if (signal === "SIGINT" || signal === "SIGTERM") process.emit(signal);
    });
  }
  const platform = process.platform;
  const failureContext = `host=${process.env.API_TYPECHECK_NATIVE_TEST_HOST ?? platform} runtime=${process.version} platform=${platform}`;
  const ownerExitChildPhase = "transition-locking";
  let iterationCount = 1;
  try {
    await exposeNativeProcessProbePhase(ownerExitChildPhase);
    if (runNativeTransitionInterruptionFixture) {
      await testNativeTransitionLockOwnerExitIteration(platform, controller.signal);
    } else {
      iterationCount = await testNativeTransitionLockOwnerExit(controller.signal);
    }
  } catch (error) {
    if (interruption) {
      console.error(error.message);
    } else {
      throw new Error(
        `[${failureContext}] transition-lock owner exit recovery failed during ${ownerExitChildPhase}: ${error.message}`,
        { cause: error },
      );
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  if (interruption) process.exit(interruption === "SIGINT" ? 130 : 143);
  console.log(
    `[${failureContext}] native transition-lock owner exit recovery passed ${iterationCount} iteration(s); each contender stayed blocked while its owner was live, reclaimed the lock after exit, and cleaned up the transition directory and owner file.`,
  );
  process.exit(0);
}

if (
  testNativeProcessIdentityTimeout ||
  testNativeProcessIdentityDescendantLifecycle
) {
  const platform =
    process.env.API_TYPECHECK_NATIVE_TEST_PLATFORM ?? process.platform;
  const failureContext = `host=${process.env.API_TYPECHECK_NATIVE_TEST_HOST ?? platform} runtime=${process.version} platform=${platform}`;
  const testDirectory = testNativeProcessIdentityDescendantLifecycle
    ? await mkdtemp(path.join(os.tmpdir(), "api-typecheck-native-timeout-"))
    : null;
  const descendantPidPath = testDirectory
    ? path.join(testDirectory, "descendant.pid")
    : null;
  const escapedPowerShellPidPath = descendantPidPath?.replace(/'/g, "''");
  const probe =
    platform === "darwin"
      ? {
          name: "ps",
          command: "/bin/sh",
          args: testNativeProcessIdentityDescendantLifecycle
            ? [
                "-c",
                'sleep 300 & descendant_pid=$!; printf "%s\\n" "$descendant_pid" > "$1"; wait "$descendant_pid"',
                "frozen-ps-probe",
                descendantPidPath,
              ]
            : ["-c", "while :; do sleep 1; done"],
        }
      : platform === "win32"
        ? {
            name: "PowerShell",
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              testNativeProcessIdentityDescendantLifecycle
                ? `$descendant = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300'; Set-Content -LiteralPath '${escapedPowerShellPidPath}' -Value $descendant.Id; Wait-Process -Id $descendant.Id`
                : "Start-Sleep -Seconds 300",
            ],
          }
        : null;
  if (!probe) {
    if (testDirectory) {
      await rm(testDirectory, { force: true, recursive: true });
    }
    throw new Error(
      `[${failureContext}] Native process identity timeout probe is only supported on macOS and Windows`,
    );
  }

  let descendantPid = null;
  try {
    let observedResult = null;
    let requestedProbe = null;
    const startedAt = Date.now();
    const identity = await getProcessIdentity(
      process.pid,
      platform,
      async (command, _args, options) => {
        requestedProbe = command;
        observedResult = await runCommandWithProcessTreeTimeout(
          probe.command,
          probe.args,
          options,
        );
        return observedResult;
      },
    );
    const elapsedMs = Date.now() - startedAt;
    const observedTermination = JSON.stringify({
      requestedProbe,
      status: observedResult?.status ?? null,
      signal: observedResult?.signal ?? null,
      errorCode: observedResult?.error?.code ?? null,
    });
    const failurePrefix = `[${failureContext}] ${probe.name} frozen identity probe elapsed=${elapsedMs}ms termination=${observedTermination}`;

    if (identity !== null) {
      throw new Error(`${failurePrefix}: unexpectedly returned an identity`);
    }
    if (observedResult?.error?.code !== "ETIMEDOUT") {
      throw new Error(
        `${failurePrefix}: was not terminated by the command timeout`,
      );
    }
    const earliestExpectedTerminationMs = processIdentityCommandTimeoutMs * 0.8;
    const latestExpectedTerminationMs =
      processIdentityCommandTimeoutMs + 10_000;
    if (
      elapsedMs < earliestExpectedTerminationMs ||
      elapsedMs > latestExpectedTerminationMs
    ) {
      throw new Error(
        `${failurePrefix}: expected termination between ${earliestExpectedTerminationMs}ms and ${latestExpectedTerminationMs}ms`,
      );
    }

    if (testNativeProcessIdentityDescendantLifecycle) {
      descendantPid = Number(
        (await readFile(descendantPidPath, "utf8")).trim(),
      );
      if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
        throw new Error(
          `${failurePrefix}: did not record a valid descendant PID at ${descendantPidPath}`,
        );
      }
      const cleanupStartedAt = Date.now();
      const cleanupDeadline = cleanupStartedAt + 10_000;
      let descendantIsAlive = processExists(descendantPid);
      while (descendantIsAlive && Date.now() < cleanupDeadline) {
        await sleep(50);
        descendantIsAlive = processExists(descendantPid);
      }
      const cleanupElapsedMs = Date.now() - cleanupStartedAt;
      if (descendantIsAlive) {
        throw new Error(
          `${failurePrefix}: descendant cleanup failed os=${platform} descendantPid=${descendantPid} cleanupElapsed=${cleanupElapsedMs}ms observedLiveness=${descendantIsAlive}`,
        );
      }

      console.log(
        `${failurePrefix}: terminated near the ${processIdentityCommandTimeoutMs}ms command timeout and descendantPid=${descendantPid} was gone after cleanupElapsed=${cleanupElapsedMs}ms observedLiveness=${descendantIsAlive}.`,
      );
    } else {
      console.log(
        `${failurePrefix}: terminated near the ${processIdentityCommandTimeoutMs}ms command timeout.`,
      );
    }
  } finally {
    if (descendantPid && processExists(descendantPid)) {
      if (platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(descendantPid), "/T", "/F"]);
      } else {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    if (testDirectory) {
      await rm(testDirectory, { force: true, recursive: true });
    }
  }
  process.exit(0);
}

async function acquireTransitionLock(
  lockEntry = primaryLockEntry,
  {
    waitTimeoutMs = lockWaitTimeoutMs,
    onOwnerStatus,
    onStaleTakeoverMoved,
    readOwner = readJson,
    renameStaleDirectory = rename,
    removeStaleDirectory = rm,
  } = {},
) {
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processIdentity: await getProcessIdentity(),
    createdAt: new Date().toISOString(),
  };
  const startedAt = Date.now();
  let blockedOwner = null;
  let blockedOwnerReadError = null;
  let handoffPhase = "transition-lock-acquisition";

  while (true) {
    try {
      handoffPhase = "transition-lock-creation";
      await mkdir(lockEntry.transitionLockDirectory);
      await writeFile(
        lockEntry.transitionOwnerPath,
        `${JSON.stringify(owner)}\n`,
        {
          flag: "wx",
        },
      );
      return owner;
    } catch (error) {
      if (error.code !== "EEXIST") {
        await rm(lockEntry.transitionLockDirectory, {
          force: true,
          recursive: true,
        }).catch(() => {});
        throw await createLockDiagnosticError(error, lockEntry, {
          phase: handoffPhase,
          transition: true,
          owner,
        });
      }

      try {
        handoffPhase = "owner-observation";
        const { owner: existingOwner, error: ownerReadError } =
          await readLockOwnerRecord(lockEntry.transitionOwnerPath, readOwner);
        blockedOwner = existingOwner;
        blockedOwnerReadError = ownerReadError;
        const transitionStats = await stat(
          lockEntry.transitionLockDirectory,
        ).catch(() => null);
        if (!transitionStats) {
          continue;
        }
        const isStale =
          Date.now() - transitionStats.mtimeMs >
          Math.min(lockStaleAfterMs, 30_000);
        const ownerStatus = ownerReadError
          ? getLockOwnerReadErrorStatus(ownerReadError)
          : await getOwnerStatus(existingOwner);
        handoffPhase = `owner-observed-${ownerStatus}`;
        if (onOwnerStatus) {
          await onOwnerStatus({
            owner: existingOwner,
            status: ownerStatus,
            lockEntry,
          });
        }
        if (isStale && ownerStatus === "dead") {
          const staleDirectory = `${lockEntry.transitionLockDirectory}.stale-${randomUUID()}`;
          try {
            handoffPhase = "stale-takeover-rename";
            await renameStaleDirectory(lockEntry.transitionLockDirectory, staleDirectory);
            if (onStaleTakeoverMoved) {
              await onStaleTakeoverMoved({
                existingOwner,
                staleDirectory,
                lockEntry,
              });
            }
            handoffPhase = "stale-takeover-owner-validation";
            const movedOwner = await readJson(
              path.join(staleDirectory, "owner.json"),
            ).catch(() => null);
            if (movedOwner?.token !== existingOwner?.token) {
              handoffPhase = "stale-takeover-rename-race";
              await rename(
                staleDirectory,
                lockEntry.transitionLockDirectory,
              ).catch(() => {});
              throw new Error(
                "Stale transition-lock directory changed during takeover",
              );
            }
            handoffPhase = "stale-takeover-cleanup";
            await removeStaleDirectory(staleDirectory, { force: true, recursive: true });
          } catch (staleError) {
            if (staleError.code !== "ENOENT") {
              throw staleError;
            }
            handoffPhase = "stale-takeover-rename-race";
          }
        } else {
          if (Date.now() - startedAt > waitTimeoutMs) {
            const ownerStatus = blockedOwnerReadError
              ? getLockOwnerReadErrorStatus(blockedOwnerReadError)
              : await getOwnerStatusDetails(blockedOwner);
            throw new Error(
              `Timed out waiting for API typecheck regression transition lock for canonical output ${lockEntry.canonicalPath}: ${formatLockOwnerDetails(blockedOwner, ownerStatus, blockedOwnerReadError)}`,
            );
          }
          await sleep(25);
        }
      } catch (handoffError) {
        throw await createLockDiagnosticError(
          handoffError,
          lockEntry,
          {
            phase: handoffPhase,
            transition: true,
            owner: blockedOwner,
          },
        );
      }
    }
  }
}

async function releaseTransitionLock(owner, lockEntry = primaryLockEntry) {
  const currentOwner = await readJson(lockEntry.transitionOwnerPath).catch(
    () => null,
  );
  if (currentOwner?.token === owner.token) {
    const recordedOwnerStatus = await getOwnerStatusDetails(currentOwner);
    try {
      if (
        testRecoveryLockCleanup &&
        recoveryCleanupBeforeRemovalError &&
        lockEntry.canonicalPath === recoveryCleanupTransitionReleaseFailurePath
      ) {
        throw recoveryCleanupBeforeRemovalError;
      }
      await rm(lockEntry.transitionLockDirectory, {
        force: true,
        recursive: true,
      });
      if (
        runRecoveryLockMultiRescanFailureFixture &&
        multiRescanReleasedOutputs.has(lockEntry.canonicalPath) &&
        multiRescanTransitionReleaseFailures.delete(lockEntry.canonicalPath)
      ) {
        throw new Error(
          `Recovery lock cleanup fixture transition release failed for ${lockEntry.canonicalPath}`,
        );
      }
      if (
        testRecoveryLockCleanup &&
        recoveryCleanupFailureInjected &&
        // Per-output transitions also release during acquisition. Wait for
        // output cleanup before injecting a failure on that kind of lock.
        (lockEntry.canonicalPath === recoveryLockEntry.canonicalPath ||
          recoveryCleanupReleaseFailureInjected) &&
        !recoveryCleanupTransitionReleaseFailureInjected &&
        lockEntry.canonicalPath === recoveryCleanupTransitionReleaseFailurePath
      ) {
        recoveryCleanupTransitionReleaseFailureInjected = true;
        throw new Error(
          `Recovery lock cleanup fixture transition release failed for ${lockEntry.canonicalPath}`,
        );
      }
    } catch (error) {
      throw await createLockDiagnosticError(error, lockEntry, {
        phase: "transition-lock-release",
        transition: true,
        owner: currentOwner,
        ownerStatus: recordedOwnerStatus,
      });
    }
  }
}

async function acquireLock(
  entries = lockEntries,
  { waitTimeoutMs = lockWaitTimeoutMs, readOwner = readJson } = {},
) {
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processIdentity: await getProcessIdentity(),
    createdAt: new Date().toISOString(),
    paths: entries.map(({ canonicalPath }) => canonicalPath),
  };
  const startedAt = Date.now();
  const acquiredEntries = [];

  try {
    for (const lockEntry of entries) {
      let blockedOwner = null;
      let blockedOwnerReadError = null;
      while (true) {
        const transitionOwner = await acquireTransitionLock(lockEntry);
        let acquired = false;
        try {
          try {
            await mkdir(lockEntry.lockDirectory);
            await writeFile(
              lockEntry.lockOwnerPath,
              `${JSON.stringify(owner)}\n`,
              {
                flag: "wx",
              },
            );
            acquired = true;
            acquiredEntries.push(lockEntry);
          } catch (error) {
            if (error.code !== "EEXIST") {
              await rm(lockEntry.lockDirectory, {
                force: true,
                recursive: true,
              }).catch(() => {});
              throw error;
            }
            const { owner: existingOwner, error: ownerReadError } =
              await readLockOwnerRecord(lockEntry.lockOwnerPath, readOwner);
            blockedOwner = existingOwner;
            blockedOwnerReadError = ownerReadError;
            const lockStats = await stat(lockEntry.lockDirectory).catch(
              () => null,
            );
            if (!lockStats) {
              continue;
            }
            const isStale = Date.now() - lockStats.mtimeMs > lockStaleAfterMs;
            const ownerStatus = ownerReadError
              ? getLockOwnerReadErrorStatus(ownerReadError)
              : await getOwnerStatus(existingOwner);
            if (isStale && ownerStatus === "dead") {
              try {
                await rm(lockEntry.lockDirectory, {
                  force: true,
                  recursive: true,
                });
              } catch (error) {
                throw await createLockDiagnosticError(error, lockEntry, {
                  phase: "stale-output-lock-reclaim",
                  owner: existingOwner,
                  ownerStatus,
                });
              }
              continue;
            }
          }
        } finally {
          await releaseTransitionLock(transitionOwner, lockEntry);
        }
        if (acquired) {
          break;
        }

        if (Date.now() - startedAt > waitTimeoutMs) {
          const ownerStatus = blockedOwnerReadError
            ? getLockOwnerReadErrorStatus(blockedOwnerReadError)
            : await getOwnerStatusDetails(blockedOwner);
          throw await createLockDiagnosticError(
            new Error(
              `Timed out waiting for API typecheck regression lock for canonical output ${lockEntry.canonicalPath}: ${formatLockOwnerDetails(blockedOwner, ownerStatus, blockedOwnerReadError)} (lock directory: ${lockEntry.lockDirectory})`,
            ),
            lockEntry,
            {
              phase: "output-lock-acquire",
              owner: blockedOwner,
              ownerStatus,
              preserveMessage: true,
            },
          );
        }
        await sleep(100);
      }
    }
    return owner;
  } catch (error) {
    await releaseLock(owner, acquiredEntries);
    throw error;
  }
}

async function releaseLock(owner, entries = lockEntries) {
  const failures = [];
  for (const lockEntry of entries) {
    let transitionOwner = null;
    let recordedOwner = null;
    let recordedOwnerStatus = null;
    try {
      transitionOwner = await acquireTransitionLock(lockEntry);
      try {
        recordedOwner = await readJson(lockEntry.lockOwnerPath).catch(
          () => null,
        );
        if (recordedOwner?.token === owner.token) {
          recordedOwnerStatus = await getOwnerStatusDetails(recordedOwner);
          await rm(lockEntry.lockDirectory, { force: true, recursive: true });
          if (
            runRecoveryLockMultiRescanFailureFixture &&
            multiRescanOutputReleaseFailures.delete(lockEntry.canonicalPath)
          ) {
            // Arm only this output's transition failure, never acquisition
            // or the concurrent publisher's transition releases.
            multiRescanReleasedOutputs.add(lockEntry.canonicalPath);
            throw new Error(
              `Recovery lock cleanup fixture release failed for ${lockEntry.canonicalPath}`,
            );
          }
          if (
            (testRecoveryLockCleanup ||
              runRecoveryLockMultiRescanFailureFixture) &&
            !recoveryCleanupReleaseFailureInjected &&
            lockEntry.canonicalPath === recoveryCleanupReleaseFailurePath
          ) {
            recoveryCleanupReleaseFailureInjected = true;
            throw new Error(
              `Recovery lock cleanup fixture release failed for ${lockEntry.canonicalPath}`,
            );
          }
        }
      } catch (error) {
        failures.push(
          await createLockDiagnosticError(error, lockEntry, {
            phase: "output-lock-release",
            owner: recordedOwner,
            ownerStatus: recordedOwnerStatus,
          }),
        );
      } finally {
        if (transitionOwner) {
          try {
            await releaseTransitionLock(transitionOwner, lockEntry);
          } catch (error) {
            failures.push(error);
          }
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw createAggregateError(
      `Failed to release one or more API typecheck regression locks for owner ${owner.token}.`,
      failures,
    );
  }
  return Date.now();
}

function createAggregateError(message, errors) {
  const details = errors
    .map((error, index) => {
      const description =
        error instanceof Error ? error.message : String(error);
      return `[${index + 1}] ${description}`;
    })
    .join("\n");
  const aggregate = new AggregateError(errors, `${message}\n${details}`);
  aggregate.lockDiagnostics = errors.flatMap((error) =>
    collectLockDiagnostics(error),
  );
  return aggregate;
}

function collectLockDiagnostics(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return [];
  }
  seen.add(error);
  if (error.lockDiagnostic) {
    return [error.lockDiagnostic];
  }
  if (Array.isArray(error.lockDiagnostics)) {
    return error.lockDiagnostics;
  }
  const nestedErrors = Array.isArray(error.errors) ? error.errors : [];
  return [
    ...nestedErrors.flatMap((nestedError) =>
      collectLockDiagnostics(nestedError, seen),
    ),
    ...(error.cause ? collectLockDiagnostics(error.cause, seen) : []),
  ];
}

function createRecoveryCleanupFailure(message, error) {
  const detail = error instanceof Error ? error.message : String(error);
  const failure = new Error(`${message}:\n${detail}`, { cause: error });
  failure.lockDiagnostics = collectLockDiagnostics(error);
  return failure;
}

function runConcurrentChild(eventPath, generatedPaths) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        API_TYPECHECK_LOCK_EVENT_PATH: eventPath,
        API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
        API_TYPECHECK_LOCK_TEST_HOLD_MS: "500",
        API_TYPECHECK_TEST_GENERATED_PATHS: generatedPaths.join(path.delimiter),
        API_TYPECHECK_TEST_VALIDATION_DELAY_MS: "500",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Concurrent harness exited with ${code ?? signal}`));
    });
  });
}

function runHarnessChild(args, env = {}) {
  return spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
}

function waitForChild(child, description) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      if (child.exitCode === 0) resolve();
      else reject(new Error(`${description} exited with ${child.exitCode}`));
      return;
    }
    if (child.signalCode !== null) {
      reject(new Error(`${description} exited with ${child.signalCode}`));
      return;
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${description} exited with ${code ?? signal}`));
    });
  });
}

async function waitForFile(filePath, child, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (!(await exists(filePath))) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error("Interrupted-run fixture exited before moving outputs");
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for interrupted-run fixture");
    }
    await sleep(25);
  }
}

async function testInterruptedNativeRecoveryDiagnosticPublication({
  testDirectory,
  diagnosticsFile,
  expectedFinalContents,
}) {
  let externalDirectory;
  let matchingSymlink;
  const readyFile = path.join(testDirectory, "partial-write-ready");
  const child = runHarnessChild(
    ["--run-native-recovery-diagnostic-interruption-fixture"],
    {
      API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE: diagnosticsFile,
      API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTIC_READY_FILE: readyFile,
    },
  );
  const childExit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitForFile(readyFile, child);
    const temporaryFiles = (await readdir(testDirectory)).filter((name) =>
      name.endsWith(".tmp"),
    );
    if (temporaryFiles.length !== 1) {
      throw new Error(
        `Expected one interrupted temporary diagnostic file, found ${temporaryFiles.length}`,
      );
    }
    const temporaryContents = await readFile(
      path.join(testDirectory, temporaryFiles[0]),
      "utf8",
    );
    let temporaryContentsAreValidJson = true;
    try {
      JSON.parse(temporaryContents);
    } catch (error) {
      temporaryContentsAreValidJson = false;
    }
    if (temporaryContentsAreValidJson) {
      throw new Error(
        "Interrupted temporary diagnostic fixture unexpectedly contains complete JSON",
      );
    }

    const visibleContents = await readOptionalTextFile(diagnosticsFile);
    if (visibleContents !== expectedFinalContents) {
      throw new Error(
        "An interrupted temporary write changed the final recovery diagnostic",
      );
    }

    child.kill();
    const { code } = await childExit;
    if (code === 0) {
      throw new Error(
        "Interrupted recovery diagnostic fixture exited successfully instead of being terminated",
      );
    }
    const finalContents = await readOptionalTextFile(diagnosticsFile);
    if (finalContents !== expectedFinalContents) {
      throw new Error(
        "Terminating a partial diagnostic write changed the final recovery diagnostic",
      );
    }
    if (finalContents !== null) {
      JSON.parse(finalContents);
    }

    // Exercise the exact scheduled collector only after the writer has exited.
    const unrelatedFiles = [
      "unrelated.tmp",
      `.other.json.${process.pid}.${randomUUID()}.tmp`,
      ".pid-reuse-recovery-batch.json.not-a-publisher.tmp",
      "unrelated-diagnostic.json",
    ];
    for (const name of unrelatedFiles) {
      await writeFile(path.join(testDirectory, name), "preserve me\n");
    }
    const matchingDirectory = `.pid-reuse-recovery-batch.json.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.join(testDirectory, matchingDirectory));
    externalDirectory = await mkdtemp(
      path.join(os.tmpdir(), "api-typecheck-diagnostic-link-target-"),
    );
    const externalTarget = path.join(externalDirectory, "preserved.txt");
    const externalContents = "preserve external diagnostic target\n";
    await writeFile(externalTarget, externalContents, { flag: "wx" });
    const linkPath = path.join(
      testDirectory,
      `.pid-reuse-recovery-batch.json.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await symlink(externalTarget, linkPath, "file");
      matchingSymlink = linkPath;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error?.code)
      ) {
        throw error;
      }
      console.log(
        `SKIP diagnostic staging symlink preservation: Windows cannot create file symlinks (${error.code}); regular abandoned-file cleanup is still checked.`,
      );
    }
    await waitForChild(runHarnessChild(
      ["--collect-native-process-diagnostics"],
      { API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR: testDirectory },
    ), "Scheduled diagnostics collector");
    const uploadedFiles = await readdir(testDirectory);
    if (uploadedFiles.includes(temporaryFiles[0])) {
      throw new Error("Abandoned partial recovery file remains in the upload directory");
    }
    if (matchingSymlink) {
      if (
        !(await lstat(matchingSymlink)).isSymbolicLink() ||
        (await readlink(matchingSymlink)) !== externalTarget
      ) {
        throw new Error("Diagnostics collection changed the recovery-staging symlink");
      }
      if ((await readFile(matchingSymlink, "utf8")) !== externalContents) {
        throw new Error("Diagnostics collection changed the linked diagnostic contents");
      }
    }
    if ((await readFile(externalTarget, "utf8")) !== externalContents) {
      throw new Error("Diagnostics collection changed the external symlink target");
    }
    if ((await readOptionalTextFile(diagnosticsFile)) !== expectedFinalContents) {
      throw new Error("Diagnostics collection changed the final recovery record");
    }
    for (const name of unrelatedFiles) {
      if ((await readFile(path.join(testDirectory, name), "utf8")) !== "preserve me\n") {
        throw new Error(`Diagnostics collection changed unrelated file ${name}`);
      }
      await rm(path.join(testDirectory, name));
    }
    if (!(await stat(path.join(testDirectory, matchingDirectory))).isDirectory()) {
      throw new Error("Diagnostics collection changed an unrelated directory");
    }
    await rm(path.join(testDirectory, matchingDirectory), { recursive: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await childExit.catch(() => {});
    }
    await rm(readyFile, { force: true });
    if (matchingSymlink) await rm(matchingSymlink, { force: true });
    if (externalDirectory) {
      await rm(externalDirectory, { force: true, recursive: true });
    }
  }
}

async function readOptionalTextFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function testNativeRecoveryDiagnosticPublicationAtomicity() {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "api-typecheck-recovery-diagnostic-atomicity-"),
  );
  const diagnosticsFile = path.join(testDirectory, "pid-reuse-recovery-batch.json");
  const priorRecord = `${JSON.stringify({ prior: "valid recovery record" })}\n`;
  const replacementRecord = `${JSON.stringify({ current: "valid recovery record" })}\n`;
  try {
    await writeFile(diagnosticsFile, priorRecord, { flag: "wx" });
    await writeNativeRecoveryDiagnosticAtomically(
      diagnosticsFile,
      replacementRecord,
    );
    if ((await readFile(diagnosticsFile, "utf8")) !== replacementRecord) {
      throw new Error(
        "Atomic recovery diagnostic publication did not replace the previous record",
      );
    }
    JSON.parse(await readFile(diagnosticsFile, "utf8"));

    await rm(diagnosticsFile, { force: true });
    await testInterruptedNativeRecoveryDiagnosticPublication({
      testDirectory,
      diagnosticsFile,
      expectedFinalContents: null,
    });

    await writeFile(diagnosticsFile, priorRecord, { flag: "wx" });
    await testInterruptedNativeRecoveryDiagnosticPublication({
      testDirectory,
      diagnosticsFile,
      expectedFinalContents: priorRecord,
    });
    await testInterruptedCollectorPublication();
    await testCollectorTemporaryDeletionFailure();
    console.log(
      "Recovery diagnostic publication is atomic; post-exit collection removes abandoned partial files while preserving final records and unrelated diagnostics.",
    );
  } finally {
    await rm(testDirectory, { force: true, recursive: true }).catch(() => {});
  }
}

async function testCollectorTemporaryDeletionFailure() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "collector-delete-failure-"));
  const temporaryNames = Array.from({ length: 3 }, () =>
    `.pid-reuse-recovery-batch.json.${process.pid}.${randomUUID()}.tmp`,
  );
  const attempts = [];
  const errors = [];
  const originalConsoleError = console.error;
  const failureMessage = "Injected recovery temporary-file deletion failure";
  try {
    for (const name of temporaryNames) {
      await writeFile(path.join(directory, name), '{"partial":');
    }
    console.error = (...args) => errors.push(args.join(" "));
    try {
      await collectNativeProcessDiagnosticsBundle({
        diagnosticsDirectory: directory,
        removeTemporaryFile: async (filePath, options) => {
          attempts.push(path.basename(filePath));
          // Fail the first attempted removal, independent of readdir ordering.
          if (attempts.length === 1) {
            throw Object.assign(new Error(failureMessage), { code: "EACCES" });
          }
          await rm(filePath, options);
        },
      });
    } finally {
      console.error = originalConsoleError;
    }
    if (
      attempts.length !== temporaryNames.length ||
      new Set(attempts).size !== temporaryNames.length ||
      temporaryNames.some((name) => !attempts.includes(name))
    ) {
      throw new Error("Collector did not attempt every matching file after a deletion failure");
    }
    const expectedError = `[native diagnostics] Could not remove abandoned recovery temporary file ${attempts[0]}: ${failureMessage}`;
    if (errors.length !== 1 || errors[0] !== expectedError) {
      throw new Error(`Collector did not report the specific deletion failure: ${JSON.stringify(errors)}`);
    }
    if ((await readFile(path.join(directory, attempts[0]), "utf8")) !== '{"partial":') {
      throw new Error("Collector changed the temporary file whose deletion failed");
    }
    for (const name of attempts.slice(1)) {
      if (await exists(path.join(directory, name))) {
        throw new Error(`Collector left a removable temporary file behind: ${name}`);
      }
    }
    const context = JSON.parse(await readFile(path.join(directory, "runner-context.json"), "utf8"));
    if (context.platform !== process.platform || context.node.version !== process.version) {
      throw new Error("Collector did not write current runner context after deletion failed");
    }
    for (const name of ["node-runtime.txt", "process-tree.txt"]) {
      if (!(await readFile(path.join(directory, name), "utf8")).trim()) {
        throw new Error(`Collector did not write ${name} after deletion failed`);
      }
    }
    console.log("Collector reports a temporary-file deletion failure, removes remaining matches, and still writes runner and process diagnostics.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function testInterruptedCollectorPublication() {
  const jsonFiles = ["probe-attribution.json", "runner-context.json"];
  for (const target of jsonFiles) {
    for (const existing of [false, true]) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "collector-atomicity-"));
      const readyFile = path.join(directory, "partial-write-ready");
      const priorRecord = '{"prior":"complete"}\n';
      let child;
      let childExit;
      try {
        if (existing) {
          for (const name of jsonFiles) {
            await writeFile(path.join(directory, name), priorRecord);
          }
        }
        child = runHarnessChild(
          ["--run-native-collector-interruption-fixture"],
          {
            API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR: directory,
            API_TYPECHECK_NATIVE_COLLECTOR_INTERRUPT_FILE: target,
            API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTIC_READY_FILE: readyFile,
          },
        );
        childExit = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        await waitForFile(readyFile, child);
        const staging = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
        if (staging.length !== 1 || !staging[0].startsWith(`.${target}.`)) {
          throw new Error(`Missing same-directory staging file for ${target}`);
        }
        const partial = await readFile(path.join(directory, staging[0]), "utf8");
        if (partial !== '{"') throw new Error("Collector fixture did not interrupt a partial JSON write");
        child.kill("SIGKILL");
        const { code } = await childExit;
        if (code === 0) throw new Error("Interrupted collector exited successfully");
        for (const name of jsonFiles) {
          const contents = await readOptionalTextFile(path.join(directory, name));
          if (contents !== null) JSON.parse(contents);
          if (name === target && contents !== (existing ? priorRecord : null)) {
            throw new Error(`Interrupted collector changed final ${name}`);
          }
        }
        // A later normal collection must publish complete replacement records.
        await waitForChild(runHarnessChild(
          ["--collect-native-process-diagnostics"],
          { API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR: directory },
        ), "Collector after interruption");
        for (const name of jsonFiles) {
          const contents = await readFile(path.join(directory, name), "utf8");
          JSON.parse(contents);
          if (contents === priorRecord) throw new Error(`Collector did not replace ${name}`);
        }
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await childExit.catch(() => {});
        }
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  console.log("Interrupted collector leaves every final JSON valid or absent, including replacement of existing records.");
}

if (process.argv.includes("--run-native-collector-interruption-fixture")) {
  const target = process.env.API_TYPECHECK_NATIVE_COLLECTOR_INTERRUPT_FILE;
  const readyFile = process.env.API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTIC_READY_FILE;
  if (!["probe-attribution.json", "runner-context.json"].includes(target) || !readyFile) {
    throw new Error("Collector interruption fixture requires a JSON target and ready path");
  }
  const keepAlive = setInterval(() => {}, 1_000);
  await collectNativeProcessDiagnosticsBundle({
    writeTemporaryFile: async (temporaryFile, contents) => {
      if (!path.basename(temporaryFile).startsWith(`.${target}.`)) {
        await writeFile(temporaryFile, contents, { flag: "wx" });
        return;
      }
      await writeFile(temporaryFile, '{"', { flag: "wx" });
      await writeFile(readyFile, "ready\n", { flag: "wx" });
      await new Promise(() => {});
    },
  });
  clearInterval(keepAlive);
  throw new Error("Collector interruption fixture unexpectedly completed");
}

if (runNativeRecoveryDiagnosticInterruptionFixture) {
  const diagnosticsFile =
    process.env.API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTICS_FILE;
  const readyFile =
    process.env.API_TYPECHECK_NATIVE_RECOVERY_DIAGNOSTIC_READY_FILE;
  if (!diagnosticsFile || !readyFile) {
    throw new Error(
      "Interrupted recovery diagnostic fixture requires diagnostic and ready paths",
    );
  }
  const keepAlive = setInterval(() => {}, 1_000);
  await writeNativeRecoveryDiagnosticAtomically(
    diagnosticsFile,
    '{"recovery":"complete"}\n',
    {
      writeTemporaryFile: async (temporaryFile, contents) => {
        await writeFile(temporaryFile, contents.slice(0, 8), { flag: "wx" });
        await writeFile(readyFile, "partial temporary write is ready\n", {
          flag: "wx",
        });
        await new Promise(() => {});
      },
    },
  );
  clearInterval(keepAlive);
  throw new Error(
    "Interrupted recovery diagnostic fixture unexpectedly completed",
  );
}

if (testNativeRecoveryDiagnosticAtomicity) {
  await testNativeRecoveryDiagnosticPublicationAtomicity();
  process.exit(0);
}

if (runTransitionLockOwnerFixture) {
  const transitionLockDirectory =
    process.env.API_TYPECHECK_TRANSITION_LOCK_DIRECTORY;
  const transitionOwnerPath = process.env.API_TYPECHECK_TRANSITION_OWNER_PATH;
  const readyPath = process.env.API_TYPECHECK_TRANSITION_READY_PATH;
  if (!transitionLockDirectory || !transitionOwnerPath || !readyPath) {
    throw new Error(
      "Transition-lock owner fixture requires lock, owner, and ready paths",
    );
  }

  const staleTimestamp = new Date(
    Date.now() - Math.max(lockStaleAfterMs, 30_000) - 1_000,
  );
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processIdentity: await getProcessIdentity(),
    createdAt: staleTimestamp.toISOString(),
  };
  await mkdir(transitionLockDirectory);
  await writeFile(transitionOwnerPath, `${JSON.stringify(owner)}\n`, {
    flag: "wx",
  });
  await utimes(transitionLockDirectory, staleTimestamp, staleTimestamp);
  await writeFile(readyPath, `${owner.token}\n`, { flag: "wx" });
  setInterval(() => {}, 1_000);
}

if (runTransitionLockOwnerReplacementFixture) {
  const transitionLockDirectory =
    process.env.API_TYPECHECK_TRANSITION_LOCK_DIRECTORY;
  const staleDirectory =
    process.env.API_TYPECHECK_TRANSITION_STALE_DIRECTORY;
  const transitionOwnerPath = process.env.API_TYPECHECK_TRANSITION_OWNER_PATH;
  const readyPath = process.env.API_TYPECHECK_TRANSITION_READY_PATH;
  if (
    !transitionLockDirectory ||
    !staleDirectory ||
    !transitionOwnerPath ||
    !readyPath
  ) {
    throw new Error(
      "Transition-lock owner replacement fixture requires active, stale, owner, and ready paths",
    );
  }

  await rename(staleDirectory, transitionLockDirectory);
  const staleTimestamp = new Date(
    Date.now() - Math.max(lockStaleAfterMs, 30_000) - 1_000,
  );
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processIdentity: await getProcessIdentity(),
    createdAt: staleTimestamp.toISOString(),
  };
  await writeFile(transitionOwnerPath, `${JSON.stringify(owner)}\n`);
  await writeFile(readyPath, `${owner.token}\n`, { flag: "wx" });
  setInterval(() => {}, 1_000);
}

if (testConcurrentRuns) {
  const testDirectory = await mkdtemp(
    path.join(workspaceRoot, ".api-typecheck-concurrency-"),
  );
  const realAncestor = path.join(testDirectory, "real");
  const aliasAncestor = path.join(testDirectory, "alias");
  try {
    await mkdir(realAncestor);
    await symlink(
      realAncestor,
      aliasAncestor,
      process.platform === "win32" ? "junction" : "dir",
    );
    const scenarios = [
      {
        name: "existing",
        runs: (realOutput, aliasOutput) => [[realOutput], [aliasOutput]],
        shouldSerialize: true,
        outputs: (realOutput) => [realOutput],
      },
      {
        name: "missing",
        runs: (realOutput, aliasOutput) => [[realOutput], [aliasOutput]],
        shouldSerialize: true,
        outputs: () => [],
      },
      {
        name: "partial-overlap",
        runs: (realOutput, aliasOutput, firstUnique, secondUnique) => [
          [realOutput, firstUnique],
          [aliasOutput, secondUnique],
        ],
        shouldSerialize: true,
        outputs: (realOutput, _aliasOutput, firstUnique, secondUnique) => [
          realOutput,
          firstUnique,
          secondUnique,
        ],
      },
      {
        name: "disjoint",
        runs: (_realOutput, _aliasOutput, firstUnique, secondUnique) => [
          [firstUnique],
          [secondUnique],
        ],
        shouldSerialize: false,
        outputs: (realOutput, _aliasOutput, firstUnique, secondUnique) => [
          firstUnique,
          secondUnique,
        ],
      },
    ];
    for (const { name, runs, shouldSerialize, outputs } of scenarios) {
      const realOutput = path.join(realAncestor, `${name}-shared-output`);
      const aliasOutput = path.join(aliasAncestor, `${name}-shared-output`);
      const firstUnique = path.join(realAncestor, `${name}-first-output`);
      const secondUnique = path.join(realAncestor, `${name}-second-output`);
      for (const outputPath of outputs(
        realOutput,
        aliasOutput,
        firstUnique,
        secondUnique,
      )) {
        await writeFile(outputPath, "generated output\n");
      }
      const eventPaths = [
        path.join(testDirectory, `${name}-first.json`),
        path.join(testDirectory, `${name}-second.json`),
      ];
      const configuredPaths = runs(
        realOutput,
        aliasOutput,
        firstUnique,
        secondUnique,
      );
      await Promise.all(
        eventPaths.map((eventPath, index) =>
          runConcurrentChild(eventPath, configuredPaths[index]),
        ),
      );
      const events = await Promise.all(eventPaths.map(readJson));
      events.sort((left, right) => left.acquiredAt - right.acquiredAt);
      const overlaps =
        events[1].acquiredAt < events[0].releasedAt &&
        events[0].acquiredAt < events[1].releasedAt;
      if (shouldSerialize && overlaps) {
        throw new Error(
          `Concurrent harness critical sections overlapped for ${name} output set`,
        );
      }
      if (!shouldSerialize && !overlaps) {
        throw new Error(
          `Concurrent harness disjoint critical sections did not overlap`,
        );
      }
    }
    console.log(
      "Concurrent API typecheck regression runs serialized aliased, partially overlapping, existing, and missing-output paths while allowing disjoint output sets to overlap.",
    );
  } finally {
    await rm(testDirectory, { force: true, recursive: true });
  }
  process.exit(0);
}

async function runInterruptedPublicationRecoveryCheck() {
  const configuredRunCount =
    process.env.API_TYPECHECK_INTERRUPTED_PUBLICATION_RUNS ?? "3";
  const runCount = Number(configuredRunCount);
  if (!Number.isSafeInteger(runCount) || runCount < 2) {
    throw new Error(
      `Interrupted publication recovery requires at least two runs; received ${JSON.stringify(configuredRunCount)}`,
    );
  }

  const fixtureDirectories = new Set();
  const pathLockDirectories = new Set();
  const crashPoints = (
    process.env.API_TYPECHECK_INTERRUPTED_PUBLICATION_CRASH_POINTS ??
    "staging,active,restore,preserve"
  ).split(",");
  if (crashPoints.length === 0 ||
      crashPoints.some((point) => !["staging", "active", "restore", "preserve"].includes(point))) {
    throw new Error("Invalid interrupted publication crash points");
  }
  for (let runNumber = 1; runNumber <= runCount; runNumber += 1) {
    for (const crashPoint of crashPoints) {
      for (const nestedOutput of [false, true]) {
        await runInterruptedPublicationRecoveryAttempt(
          runNumber,
          runCount,
          fixtureDirectories,
          pathLockDirectories,
          crashPoint,
          nestedOutput,
        );
      }
    }
  }
  console.log(
    `Completed ${runCount} isolated runs each for single-file and nested-directory crash points: ${crashPoints.join(", ")}.`,
  );
}

async function runInterruptedPublicationRecoveryAttempt(
  runNumber,
  runCount,
  fixtureDirectories,
  pathLockDirectories,
  crashPoint,
  nestedOutput,
) {
  const preserveNewer = crashPoint === "preserve";
  const restoreBackup = crashPoint === "restore" || preserveNewer;
  const activePublication = crashPoint === "active";
  const publicationDirectory = await mkdtemp(
    path.join(
      workspaceRoot,
      `api-typecheck-interrupted-publication-${runNumber}-`,
    ),
  );
  if (fixtureDirectories.has(publicationDirectory)) {
    await rm(publicationDirectory, { force: true, recursive: true });
    throw new Error(
      `Interrupted publication run ${runNumber} reused fixture directory ${publicationDirectory}`,
    );
  }
  fixtureDirectories.add(publicationDirectory);
  const publicationSource = path.join(publicationDirectory, "generated-output");
  const unrelatedOutput = path.join(
    publicationDirectory,
    "unrelated-generated-output",
  );
  const publicationReadyPath = path.join(publicationDirectory, "ready");
  let publisherChild;
  let publicationSourceEntry;
  try {
    if (nestedOutput) {
      await createNestedPublicationOutput(publicationSource);
    } else {
      await writeFile(publicationSource, "published output\n", {
        flag: "wx",
      });
      await chmod(publicationSource, 0o640);
      const originalTime = new Date("2001-02-03T04:05:06.000Z");
      await utimes(publicationSource, originalTime, originalTime);
    }
    const originalGeneratedFileMetadata =
      await readGeneratedFileMetadata(publicationSource);
    const originalTreeMetadata = await readGeneratedTreeMetadata(publicationSource);
    const originalContents = await fingerprint(publicationSource);
    await writeFile(unrelatedOutput, "unrelated output\n", {
      flag: "wx",
    });
    publicationSourceEntry = createLockEntry(
      await canonicalizePath(publicationSource),
    );
    if (pathLockDirectories.has(publicationSourceEntry.lockDirectory)) {
      throw new Error(
        `Interrupted publication run ${runNumber} reused path lock ${publicationSourceEntry.lockDirectory}`,
      );
    }
    pathLockDirectories.add(publicationSourceEntry.lockDirectory);
    publisherChild = runHarnessChild(
      ["--run-interrupted-publication-fixture"],
      {
        API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
        API_TYPECHECK_TEST_GENERATED_PATHS: publicationSource,
        API_TYPECHECK_INTERRUPTED_PUBLICATION_READY_PATH: publicationReadyPath,
        API_TYPECHECK_INTERRUPTED_PUBLICATION_RESTORE_BACKUP: restoreBackup ? "1" : "0",
        API_TYPECHECK_INTERRUPTED_PUBLICATION_AFTER_PROMOTION: activePublication ? "1" : "0",
      },
    );
    await waitForFile(publicationReadyPath, publisherChild);
    const publicationReady = await readJson(publicationReadyPath);
    if (
      typeof publicationReady?.creatingDirectory !== "string" ||
      typeof publicationReady?.activeDirectory !== "string"
    ) {
      throw new Error(
        "Interrupted publisher did not record its staging and active directories",
      );
    }
    if (crashPoint === "staging" && !(await exists(publicationReady.creatingDirectory))) {
      throw new Error(
        "Interrupted publisher did not leave staging state before publication",
      );
    }
    if (crashPoint === "staging" && await exists(publicationReady.activeDirectory)) {
      throw new Error(
        "Interrupted publisher published its active directory before interruption",
      );
    }
    if (activePublication) {
      if (await exists(publicationReady.creatingDirectory) ||
          !(await exists(publicationReady.activeDirectory)) ||
          await exists(path.join(publicationReady.activeDirectory, "backup/generated-output")) ||
          JSON.stringify(await fingerprint(publicationSource)) !== JSON.stringify(originalContents) ||
          JSON.stringify(await readGeneratedTreeMetadata(publicationSource)) !== JSON.stringify(originalTreeMetadata)) {
        throw new Error("Publisher did not stop immediately after promotion with untouched output and no backup");
      }
      const manifest = await readJson(path.join(publicationReady.activeDirectory, "manifest.json"));
      if (manifest.phase !== "prepared" || manifest.validationOwner !== null) {
        throw new Error("Promoted publisher unexpectedly started validation");
      }
    }
    if (restoreBackup) {
      if (!(await exists(publicationReady.activeDirectory)) ||
          JSON.stringify(await fingerprint(publicationSource)) === JSON.stringify(originalContents)) {
        throw new Error("Interrupted validation did not leave a backup and partial output");
      }
      const backupPath = path.join(
        publicationReady.activeDirectory,
        "backup/generated-output",
      );
      if (JSON.stringify(await fingerprint(backupPath)) !== JSON.stringify(originalContents) ||
          JSON.stringify(await readGeneratedTreeMetadata(backupPath)) !== JSON.stringify(originalTreeMetadata)) {
        throw new Error("Interrupted publisher backup did not preserve the original generated tree and metadata");
      }
      const partialMetadata = await readGeneratedFileMetadata(publicationSource);
      if (partialMetadata.mtimeMs === originalGeneratedFileMetadata.mtimeMs ||
          (process.platform !== "win32" &&
           partialMetadata.mode === originalGeneratedFileMetadata.mode)) {
        throw new Error("Partial output must have distinct metadata before recovery");
      }
      if (nestedOutput) {
        const partialTreeMetadata = await readGeneratedTreeMetadata(publicationSource);
        for (const relativePath of [
          "partial-only",
          path.join("partial-only", "stale.d.ts"),
          path.join("nested", "deeper", "stale.d.ts"),
        ]) {
          if (!partialTreeMetadata.some((entry) => entry.relativePath === relativePath) ||
              originalTreeMetadata.some((entry) => entry.relativePath === relativePath)) {
            throw new Error(`Expected validation-only output before recovery: ${relativePath}`);
          }
        }
        for (const original of originalTreeMetadata) {
          const partial = partialTreeMetadata.find(
            (entry) => entry.relativePath === original.relativePath,
          );
          if (!partial || partial.kind !== original.kind ||
              partial.mtimeMs === original.mtimeMs ||
              (process.platform !== "win32" && partial.mode === original.mode)) {
            throw new Error(`Nested partial output must have distinct metadata: ${original.relativePath}`);
          }
        }
      }
    }

    try {
      if (process.platform === "win32") {
        publisherChild.kill("SIGKILL");
      } else {
        process.kill(-publisherChild.pid, "SIGKILL");
      }
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
    await new Promise((resolve) => {
      if (
        publisherChild.exitCode !== null ||
        publisherChild.signalCode !== null
      ) {
        resolve();
      } else {
        publisherChild.once("exit", resolve);
      }
    });

    const expectedContents = preserveNewer
      ? await fingerprint(publicationSource) : originalContents;
    const expectedTreeMetadata = preserveNewer
      ? await readGeneratedTreeMetadata(publicationSource) : originalTreeMetadata;
    const expectedFileMetadata = preserveNewer
      ? await readGeneratedFileMetadata(publicationSource) : originalGeneratedFileMetadata;
    // A real declaration-presence check, isolated from workspace build output.
    const declarationDirectory = path.join(publicationDirectory, "declarations");
    await mkdir(declarationDirectory);
    await writeFile(path.join(declarationDirectory, "index.d.ts"), "export {};\n");
    const recoveryChild = runHarnessChild(
      ["--run-interrupted-publication-recovery"],
      {
        API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
        API_TYPECHECK_TEST_GENERATED_PATHS: publicationSource,
        // Select verification success/failure without running the workspace compiler.
        API_TYPECHECK_TEST_VALIDATION_DELAY_MS: "1",
        API_TYPECHECK_TEST_VALIDATION_FAIL: preserveNewer ? "0" : "1",
        API_TYPECHECK_TEST_DECLARATION_DIRECTORY: declarationDirectory,
      },
    );
    await waitForChild(recoveryChild, "Interrupted publication recovery");

    if (await exists(publicationReady.creatingDirectory)) {
      throw new Error(
        "Recovery left staging state from the interrupted publisher",
      );
    }
    if (await exists(publicationReady.activeDirectory)) {
      throw new Error("Recovery left a partially published active directory");
    }
    if (JSON.stringify(await fingerprint(publicationSource)) !== JSON.stringify(expectedContents)) {
      throw new Error(
        "Recovery did not preserve the expected generated output content",
      );
    }
    const recoveredTreeMetadata = await readGeneratedTreeMetadata(publicationSource);
    if (JSON.stringify(recoveredTreeMetadata) !== JSON.stringify(expectedTreeMetadata)) {
      throw new Error(
        `Recovery changed generated tree metadata: expected ${JSON.stringify(expectedTreeMetadata)}, received ${JSON.stringify(recoveredTreeMetadata)}`,
      );
    }
    const recoveredGeneratedFileMetadata =
      await readGeneratedFileMetadata(publicationSource);
    if (
      recoveredGeneratedFileMetadata.mode !==
        expectedFileMetadata.mode ||
      recoveredGeneratedFileMetadata.mtimeMs !==
        expectedFileMetadata.mtimeMs
    ) {
      throw new Error(
        "Recovery did not preserve the original generated output permissions and modification time",
      );
    }
    if ((await readFile(unrelatedOutput, "utf8")) !== "unrelated output\n") {
      throw new Error("Recovery changed unrelated generated output");
    }

    const lockPaths = [
      publicationSourceEntry.lockDirectory,
      publicationSourceEntry.transitionLockDirectory,
      recoveryLockEntry.transitionLockDirectory,
    ];
    const existingLocks = (
      await Promise.all(
        lockPaths.map(async (lockPath) =>
          (await exists(lockPath)) ? lockPath : null,
        ),
      )
    ).filter(Boolean);
    if (existingLocks.length > 0) {
      throw new Error(
        `Interrupted publication recovery left locks behind: ${existingLocks.join(", ")}`,
      );
    }

    console.log(
      `Interrupted publication run ${runNumber} of ${runCount} ${preserveNewer ? "retained newer verified content, permissions, and modification time" : restoreBackup ? "restored backup content, permissions, and modification time" : activePublication ? "removed active prepared transaction" : "removed unpublished staging"} (${nestedOutput ? "nested-directory" : "single-file"}), preserved unrelated generated output, and released the path and transition locks.`,
    );
  } finally {
    if (
      publisherChild?.pid &&
      publisherChild.exitCode === null &&
      publisherChild.signalCode === null
    ) {
      try {
        if (process.platform === "win32") publisherChild.kill("SIGKILL");
        else process.kill(-publisherChild.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await new Promise((resolve) => {
        if (
          publisherChild.exitCode !== null ||
          publisherChild.signalCode !== null
        ) {
          resolve();
        } else {
          publisherChild.once("exit", resolve);
        }
      });
    }
    await rm(publicationDirectory, { force: true, recursive: true });
  }
}

if (testInterruptedPublication) {
  await runInterruptedPublicationRecoveryCheck();
  process.exit(0);
}

if (testInterruptedRecovery) {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "api-typecheck-interruption-"),
  );
  const readyPath = path.join(testDirectory, "backup-ready");
  const removedGeneratedRelativePath =
    ".api-typecheck-regression-removed-generated-path";
  const removedGeneratedPath = path.join(
    workspaceRoot,
    removedGeneratedRelativePath,
  );
  const originalRemovedOutput = "original generated output\n";
  let interruptedChild;
  try {
    await writeFile(removedGeneratedPath, originalRemovedOutput, {
      flag: "wx",
    });
    const baselineChild = runHarnessChild([], {
      API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
      API_TYPECHECK_EXTRA_GENERATED_PATHS: removedGeneratedRelativePath,
    });
    await waitForChild(baselineChild, "Baseline recovery harness");
    const originalRemovedMetadata = await readGeneratedFileMetadata(removedGeneratedPath);
    interruptedChild = runHarnessChild([], {
      API_TYPECHECK_VALIDATION_ACTIVE_PATH: readyPath,
      API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
      API_TYPECHECK_EXTRA_GENERATED_PATHS: removedGeneratedRelativePath,
    });
    await waitForFile(readyPath, interruptedChild);
    if (process.platform === "win32") {
      interruptedChild.kill("SIGKILL");
    } else {
      process.kill(-interruptedChild.pid, "SIGKILL");
    }
    await new Promise((resolve) => {
      if (
        interruptedChild.exitCode !== null ||
        interruptedChild.signalCode !== null
      ) {
        resolve();
      } else {
        interruptedChild.once("exit", resolve);
      }
    });
    await writeFile(removedGeneratedPath, "conflicting partial output\n", {
      flag: "wx",
    });

    const activeTransactionName = (await readdir(workspaceRoot)).find((entry) =>
      entry.startsWith(".api-typecheck-regression-active-"),
    );
    if (!activeTransactionName) {
      throw new Error("Interrupted run did not leave an active transaction");
    }
    const interruptedManifest = await readJson(
      path.join(workspaceRoot, activeTransactionName, "manifest.json"),
    );
    if (!(await isOwnerAlive(interruptedManifest.validationOwner))) {
      throw new Error(
        "Validation subprocess was not active when the harness was interrupted",
      );
    }
    const abandonedValidationOwner = interruptedManifest.validationOwner;
    const incompleteDirectory = await mkdtemp(
      path.join(workspaceRoot, ".api-typecheck-regression-creating-"),
    );
    await writeFile(path.join(incompleteDirectory, "manifest.json.tmp"), "{");

    const recoveryChild = runHarnessChild([], {
      API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
    });
    await waitForChild(recoveryChild, "Recovery harness");

    if (await isOwnerAlive(abandonedValidationOwner)) {
      throw new Error("Recovery left the abandoned validation process running");
    }
    if (await exists(incompleteDirectory)) {
      throw new Error("Recovery left an incomplete transaction directory");
    }
    if (!(await declarationsExist())) {
      throw new Error(
        "Interrupted-run recovery did not leave valid generated declarations",
      );
    }
    if (
      (await readFile(removedGeneratedPath, "utf8")) !== originalRemovedOutput
    ) {
      throw new Error(
        "Recovery did not restore the backup for a removed generated path",
      );
    }
    const recoveredRemovedMetadata = await readGeneratedFileMetadata(removedGeneratedPath);
    if (recoveredRemovedMetadata.mode !== originalRemovedMetadata.mode ||
        recoveredRemovedMetadata.mtimeMs !== originalRemovedMetadata.mtimeMs) {
      throw new Error("Recovery did not restore metadata for a removed generated path");
    }
    console.log(
      "A later API typecheck regression run recovered outputs abandoned by a forcibly terminated run.",
    );

    await runInterruptedPublicationRecoveryCheck();
  } finally {
    if (interruptedChild?.pid) {
      try {
        if (process.platform === "win32") interruptedChild.kill("SIGKILL");
        else process.kill(-interruptedChild.pid, "SIGKILL");
      } catch {}
    }
    await rm(removedGeneratedPath, { force: true, recursive: true });
    await rm(testDirectory, { force: true, recursive: true });
  }
  process.exit(0);
}

const creatingBackupPrefix = ".api-typecheck-regression-creating-";
const activeBackupPrefix = ".api-typecheck-regression-active-";
const backupManifestName = "manifest.json";

async function writeManifest(directory, manifest) {
  const temporaryPath = path.join(
    directory,
    `${backupManifestName}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporaryPath, path.join(directory, backupManifestName));
}

async function declarationsExist() {
  const libraries = runInterruptedPublicationRecovery &&
      process.env.API_TYPECHECK_TEST_DECLARATION_DIRECTORY
    ? [{ directory: process.env.API_TYPECHECK_TEST_DECLARATION_DIRECTORY,
         declarationDirectory: "." }]
    : declarationLibraries;
  for (const library of libraries) {
    const declarationDirectory = path.resolve(
      library.directory,
      library.declarationDirectory,
    );
    const declarations = await readdir(declarationDirectory, {
      recursive: true,
    }).catch(() => []);
    if (!declarations.some((entry) => entry.endsWith(".d.ts"))) {
      return false;
    }
  }
  return true;
}

async function runTrackedValidation(transactionDirectory, manifest) {
  const goPath = path.join(
    transactionDirectory,
    `.validation-go-${randomUUID()}`,
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--run-validation-child"],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        API_TYPECHECK_VALIDATION_GO_PATH: goPath,
      },
      stdio: "inherit",
      detached: process.platform !== "win32",
    },
  );
  manifest.phase = "validation-running";
  manifest.validationOwner = {
    pid: child.pid,
    hostname: os.hostname(),
    processIdentity: await getProcessIdentity(child.pid),
  };
  await writeManifest(transactionDirectory, manifest);
  await writeFile(goPath, "go\n", { flag: "wx" });

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await rm(goPath, { force: true });
  manifest.phase = "validation-complete";
  manifest.validationOwner = null;
  await writeManifest(transactionDirectory, manifest);
  return result;
}

async function stopAbandonedValidation(owner) {
  if (!(await isOwnerAlive(owner))) {
    return;
  }
  if (process.platform === "win32") {
    process.kill(owner.pid, "SIGKILL");
  } else {
    process.kill(-owner.pid, "SIGKILL");
  }
  const startedAt = Date.now();
  while (await isOwnerAlive(owner)) {
    if (Date.now() - startedAt > 10_000) {
      throw new Error(
        `Timed out stopping abandoned validation process ${owner.pid}`,
      );
    }
    await sleep(25);
  }
}

async function resolveManifestPaths(manifest, manifestPath) {
  if (!Array.isArray(manifest.paths)) {
    throw new Error(`Invalid backup path list: ${manifestPath}`);
  }

  if (manifest.version === 1) {
    if (manifest.lockKey !== lockKey) {
      throw new Error(
        `Cannot safely match legacy API typecheck backup after generated paths changed: ${manifestPath}. Restore the earlier path configuration or inspect and retire this transaction manually.`,
      );
    }
    return manifest.paths;
  }

  if (manifest.version !== 2) {
    throw new Error(`Unrecognized API typecheck backup: ${manifestPath}`);
  }

  const resolvedItems = manifest.paths.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.sourceRelativePath !== "string" ||
      path.isAbsolute(item.sourceRelativePath)
    ) {
      throw new Error(
        `Invalid workspace-relative source path: ${manifestPath}`,
      );
    }
    const source = path.resolve(workspaceRoot, item.sourceRelativePath);
    if (
      source === workspaceRoot ||
      !source.startsWith(`${workspaceRoot}${path.sep}`)
    ) {
      throw new Error(
        `Backup source path escapes the workspace: ${manifestPath}`,
      );
    }
    return { ...item, source };
  });
  const sources = resolvedItems.map(({ source }) => source).sort();
  if (new Set(sources).size !== sources.length) {
    throw new Error(`Ambiguous duplicate backup source paths: ${manifestPath}`);
  }
  const configuredLockKey = createHash("sha256")
    .update(sources.join("\0"))
    .digest("hex")
    .slice(0, 16);
  const canonicalSources = [
    ...new Set(await Promise.all(sources.map(canonicalizePath))),
  ].sort();
  const canonicalLockKey = createHash("sha256")
    .update(canonicalSources.join("\0"))
    .digest("hex")
    .slice(0, 16);
  if (
    manifest.lockKey !== canonicalLockKey &&
    manifest.lockKey !== configuredLockKey
  ) {
    throw new Error(
      `Backup path set does not match its recorded lock key: ${manifestPath}`,
    );
  }
  return resolvedItems;
}

function formatForeignHostRecoveryError(transactions) {
  return [
    "Refusing to recover API typecheck backups owned by another host:",
    ...transactions
      .sort((left, right) =>
        left.abandonedDirectory.localeCompare(right.abandonedDirectory),
      )
      .flatMap(({ abandonedDirectory, foreignHostOwners, foreignHostOwner }) =>
        (foreignHostOwners ?? [foreignHostOwner]).map(
          (owner) =>
            `${abandonedDirectory} (affected transaction: ${abandonedDirectory}, ${owner?.role ?? "owner"}, owner PID: ${Number.isInteger(owner?.pid) ? owner.pid : "unavailable"}, hostname: ${owner?.hostname || "unavailable"}, ${formatLockOwnerAge(owner)}, canonical output: ${owner?.canonicalSources?.join(", ") || "unavailable"})`,
        ),
      ),
  ].join("\n");
}

async function preflightAbandonedBackup(
  entry,
  { includeDisjoint = false } = {},
) {
  const abandonedDirectory = path.join(workspaceRoot, entry.name);
  const manifestPath = path.join(abandonedDirectory, backupManifestName);
  const manifest = await readJson(manifestPath).catch(() => null);
  if (!manifest) {
    throw new Error(
      `Cannot safely recover unrecognized API typecheck backup: ${abandonedDirectory}`,
    );
  }
  const manifestPaths = await resolveManifestPaths(manifest, manifestPath);
  const manifestCanonicalSources = await Promise.all(
    manifestPaths.map(({ source }) => canonicalizePath(source)),
  );
  if (
    !includeDisjoint &&
    !manifestCanonicalSources.some((source) =>
      canonicalLockedPaths.includes(source),
    )
  ) {
    return null;
  }
  if (manifest.version === 2) {
    const transactionOwnerStatus = await getOwnerStatus(
      manifest.transactionOwner,
    );
    const validationOwnerStatus = await getOwnerStatus(
      manifest.validationOwner,
    );
    const malformedOwners = {};
    if (transactionOwnerStatus === "malformed") {
      malformedOwners.malformedOwner = {
        reason: `transaction owner: ${getOwnerRecordValidationError(manifest.transactionOwner)}`,
      };
    }
    if (validationOwnerStatus === "malformed") {
      malformedOwners.malformedValidationOwner = {
        reason: `validation owner: ${getOwnerRecordValidationError(manifest.validationOwner)}`,
      };
    }
    const ownerIssues = { abandonedDirectory, ...malformedOwners };
    const foreignHostOwners = [];
    if (transactionOwnerStatus === "live") {
      if (
        includeDisjoint &&
        !manifestCanonicalSources.some((source) =>
          canonicalLockedPaths.includes(source),
        )
      ) {
        return null;
      }
      ownerIssues.liveOwner = {
        pid: manifest.transactionOwner?.pid,
        hostname: manifest.transactionOwner?.hostname,
        createdAt: manifest.transactionOwner?.createdAt,
        isTransactionOwner: true,
      };
    }
    if (
      manifest.transactionOwner &&
      transactionOwnerStatus === "host-mismatch"
    ) {
      foreignHostOwners.push({
        pid: manifest.transactionOwner.pid,
        hostname: manifest.transactionOwner.hostname,
        createdAt: manifest.transactionOwner.createdAt,
        canonicalSources: manifestCanonicalSources,
        role: "transaction owner",
      });
    }
    if (manifest.validationOwner && validationOwnerStatus === "host-mismatch") {
      foreignHostOwners.push({
        pid: manifest.validationOwner.pid,
        hostname: manifest.validationOwner.hostname,
        createdAt: manifest.validationOwner.createdAt,
        canonicalSources: manifestCanonicalSources,
        role: "validation owner",
      });
    }
    if (foreignHostOwners.length > 0) {
      ownerIssues.foreignHostOwners = foreignHostOwners;
    }
    const reusedOwners = [];
    if (transactionOwnerStatus === "reused") {
      reusedOwners.push({
        role: "transaction owner",
        createdAt: manifest.transactionOwner?.createdAt,
      });
    }
    if (validationOwnerStatus === "reused") {
      reusedOwners.push({
        role: "validation owner",
        createdAt: manifest.validationOwner?.createdAt,
      });
    }
    if (reusedOwners.length > 0) {
      ownerIssues.reusedOwner = { owners: reusedOwners };
    }
    if (Object.keys(ownerIssues).length > 1) {
      return ownerIssues;
    }
  }
  const backupItems = [];
  const backupPaths = new Set();
  let hasConflictingOutput = false;
  for (const item of manifestPaths) {
    if (
      typeof item.source !== "string" ||
      typeof item.backupRelativePath !== "string" ||
      path.isAbsolute(item.backupRelativePath)
    ) {
      throw new Error(
        `Cannot safely recover invalid backup manifest: ${manifestPath}`,
      );
    }
    const backupPath = path.resolve(
      abandonedDirectory,
      item.backupRelativePath,
    );
    if (
      backupPath !== abandonedDirectory &&
      !backupPath.startsWith(`${abandonedDirectory}${path.sep}`)
    ) {
      throw new Error(
        `Backup path escapes its transaction directory: ${manifestPath}`,
      );
    }
    if (backupPaths.has(backupPath)) {
      throw new Error(
        `Ambiguous duplicate backup destinations: ${manifestPath}`,
      );
    }
    backupPaths.add(backupPath);
    const backupExists = await exists(backupPath);
    const sourceFingerprint = await fingerprint(item.source);
    const backupFingerprint = backupExists
      ? await fingerprint(backupPath)
      : null;
    const originalFingerprint = item.originalFingerprint ?? null;
    if (
      sourceFingerprint !== null &&
      JSON.stringify(sourceFingerprint) !== JSON.stringify(originalFingerprint)
    ) {
      hasConflictingOutput = true;
    }
    backupItems.push({
      ...item,
      canonicalSource: await canonicalizePath(item.source),
      backupPath,
      backupExists,
      backupFingerprint,
      sourceFingerprint,
    });
  }
  return {
    abandonedDirectory,
    manifest,
    manifestPath,
    backupItems,
    hasConflictingOutput,
  };
}

function assertUniqueRecoverySources(abandonedBackups) {
  const claimsBySource = new Map();
  for (const { abandonedDirectory, backupItems } of abandonedBackups) {
    for (const { source, canonicalSource } of backupItems) {
      const claim = claimsBySource.get(canonicalSource) ?? {
        paths: new Set(),
        transactions: [],
      };
      claim.paths.add(source);
      claim.transactions.push(abandonedDirectory);
      claimsBySource.set(canonicalSource, claim);
    }
  }

  const conflicts = [...claimsBySource]
    .filter(([, claim]) => claim.transactions.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));
  if (conflicts.length === 0) {
    return;
  }

  const details = conflicts
    .map(
      ([canonicalSource, claim]) =>
        `${[...claim.paths].sort().join(" and ")} resolve to ${canonicalSource} and are claimed by ${claim.transactions.sort().join(", ")}`,
    )
    .join("; ");
  throw new Error(
    `Ambiguous generated sources across active API typecheck recovery transactions: ${details}`,
  );
}

async function recoverAbandonedBackupsUnlocked({
  includeDisjoint = false,
} = {}) {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const activeEntries = entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(activeBackupPrefix),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const abandonedBackups = [];
  const liveOwnerTransactions = [];
  const reusedOwnerTransactions = [];
  const malformedOwnerTransactions = [];
  const malformedValidationOwnerTransactions = [];
  const foreignHostTransactions = [];
  for (const entry of activeEntries) {
    const abandonedBackup = await preflightAbandonedBackup(entry, {
      includeDisjoint,
    });
    if (abandonedBackup) {
      if (abandonedBackup.malformedOwner) {
        malformedOwnerTransactions.push(abandonedBackup);
      }
      if (abandonedBackup.malformedValidationOwner) {
        malformedValidationOwnerTransactions.push(abandonedBackup);
      }
      if (abandonedBackup.liveOwner) {
        liveOwnerTransactions.push(abandonedBackup);
      }
      if (abandonedBackup.foreignHostOwners) {
        foreignHostTransactions.push(abandonedBackup);
      }
      if (abandonedBackup.reusedOwner) {
        reusedOwnerTransactions.push(abandonedBackup);
      }
      if (
        !abandonedBackup.liveOwner &&
        !abandonedBackup.foreignHostOwners &&
        !abandonedBackup.reusedOwner &&
        !abandonedBackup.malformedOwner &&
        !abandonedBackup.malformedValidationOwner
      ) {
        abandonedBackups.push(abandonedBackup);
      }
    }
  }
  if (
    liveOwnerTransactions.length > 0 ||
    foreignHostTransactions.length > 0 ||
    reusedOwnerTransactions.length > 0 ||
    malformedOwnerTransactions.length > 0 ||
    malformedValidationOwnerTransactions.length > 0
  ) {
    const recoveryErrors = [];
    if (liveOwnerTransactions.length > 0) {
      recoveryErrors.push(
        "Refusing to recover API typecheck backups still owned by live runs:",
        ...liveOwnerTransactions
          .sort((left, right) =>
            left.abandonedDirectory.localeCompare(right.abandonedDirectory),
          )
          .map(
            ({ abandonedDirectory, liveOwner }) =>
              `${abandonedDirectory} (owner PID: ${Number.isInteger(liveOwner?.pid) ? liveOwner.pid : "unavailable"}, hostname: ${liveOwner?.hostname || "unavailable"}, transaction owner: ${liveOwner?.isTransactionOwner ? "yes" : "no"}, ${formatLockOwnerAge(liveOwner)})`,
          ),
      );
    }
    if (foreignHostTransactions.length > 0) {
      recoveryErrors.push(
        formatForeignHostRecoveryError(foreignHostTransactions),
      );
    }
    if (reusedOwnerTransactions.length > 0) {
      recoveryErrors.push(
        "Refusing to recover API typecheck backups whose owner PIDs were reused:",
        ...reusedOwnerTransactions
          .sort((left, right) =>
            left.abandonedDirectory.localeCompare(right.abandonedDirectory),
          )
          .map(
            ({ abandonedDirectory, reusedOwner }) =>
              `${abandonedDirectory} (${reusedOwner.owners
                .map(
                  ({ role, createdAt }) =>
                    `${role}, ${formatLockOwnerAge({ createdAt })}`,
                )
                .join("; ")})`,
          ),
      );
    }
    if (malformedOwnerTransactions.length > 0) {
      recoveryErrors.push(
        "Refusing to recover API typecheck backups with malformed transaction owner records:",
        ...malformedOwnerTransactions
          .sort((left, right) =>
            left.abandonedDirectory.localeCompare(right.abandonedDirectory),
          )
          .map(
            ({ abandonedDirectory, malformedOwner }) =>
              `${abandonedDirectory} (${malformedOwner.reason})`,
          ),
      );
    }
    if (malformedValidationOwnerTransactions.length > 0) {
      recoveryErrors.push(
        "Refusing to recover API typecheck backups with malformed validation owner records:",
        ...malformedValidationOwnerTransactions
          .sort((left, right) =>
            left.abandonedDirectory.localeCompare(right.abandonedDirectory),
          )
          .map(
            ({ abandonedDirectory, malformedValidationOwner }) =>
              `${abandonedDirectory} (${malformedValidationOwner.reason})`,
          ),
      );
    }
    throw new Error(recoveryErrors.join("\n"));
  }
  assertUniqueRecoverySources(abandonedBackups);

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(creatingBackupPrefix)) {
      await rm(path.join(workspaceRoot, entry.name), {
        force: true,
        recursive: true,
      });
    }
  }

  for (const {
    abandonedDirectory,
    manifest,
    backupItems,
    hasConflictingOutput,
  } of abandonedBackups) {
    await stopAbandonedValidation(manifest.validationOwner);
    await rm(failureFixture, { force: true });

    if (hasConflictingOutput) {
      const interruptedDuringValidation =
        manifest.phase === "validation-running" ||
        manifest.phase === "validation-complete";
      const verification = await runTrackedValidation(
        abandonedDirectory,
        manifest,
      );
      if (verification.code === 0 && (await declarationsExist())) {
        for (const item of backupItems) {
          if (lockedPaths.includes(item.source)) {
            continue;
          }
          if (item.backupExists) {
            await rm(item.source, { force: true, recursive: true });
            await mkdir(path.dirname(item.source), { recursive: true });
            await rename(item.backupPath, item.source);
          } else if (item.originalFingerprint === null) {
            await rm(item.source, { force: true, recursive: true });
          }
        }
        await rm(abandonedDirectory, { force: true, recursive: true });
        continue;
      }
      if (!interruptedDuringValidation) {
        throw new Error(
          `Refusing to overwrite unverified newer generated output while recovering ${abandonedDirectory}`,
        );
      }
      for (const generatedPath of lockedPaths) {
        await rm(generatedPath, { force: true, recursive: true });
      }
    }

    for (const item of backupItems) {
      if (item.backupExists) {
        await rm(item.source, { force: true, recursive: true });
        await mkdir(path.dirname(item.source), { recursive: true });
        await rename(item.backupPath, item.source);
      } else if (item.originalFingerprint === null) {
        await rm(item.source, { force: true, recursive: true });
      }
    }
    await rm(abandonedDirectory, { force: true, recursive: true });
  }
}

async function discoverDisjointRecoveryLockEntries() {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const canonicalSources = new Set();
  const discoveryErrors = [];
  const foreignHostTransactions = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(activeBackupPrefix)) {
      continue;
    }

    const abandonedDirectory = path.join(workspaceRoot, entry.name);
    const manifestPath = path.join(abandonedDirectory, backupManifestName);
    const manifest = await readJson(manifestPath).catch(() => null);
    if (!manifest) {
      throw new Error(
        `Cannot safely recover unrecognized API typecheck backup: ${abandonedDirectory}`,
      );
    }

    // A live transaction already owns its output locks. Waiting for those
    // locks here would make disjoint checks wait on one another, and its
    // normal owner check below will continue to protect it.
    const transactionOwnerStatus =
      manifest.version === 2 && manifest.transactionOwner
        ? await getOwnerStatus(manifest.transactionOwner)
        : null;
    const validationOwnerStatus =
      manifest.version === 2 && manifest.validationOwner
        ? await getOwnerStatus(manifest.validationOwner)
        : null;
    if (transactionOwnerStatus === "live") {
      if (validationOwnerStatus !== "host-mismatch") {
        continue;
      }
    }

    let manifestPaths;
    try {
      manifestPaths = await resolveManifestPaths(manifest, manifestPath);
    } catch (error) {
      discoveryErrors.push(error);
      continue;
    }
    if (manifest.version !== 2) {
      // Legacy manifests can only be recovered when their lock key matches
      // this check's current path set, so the current locks already cover
      // them.
      continue;
    }

    const manifestCanonicalSources = [];
    for (const item of manifestPaths) {
      if (typeof item?.source !== "string") {
        throw new Error(
          `Cannot safely recover invalid backup manifest: ${manifestPath}`,
        );
      }
      const canonicalSource = await canonicalizePath(item.source);
      manifestCanonicalSources.push(canonicalSource);
      if (!canonicalLockedPaths.includes(canonicalSource)) {
        canonicalSources.add(canonicalSource);
      }
    }
    const foreignHostOwners = [];
    if (transactionOwnerStatus === "host-mismatch") {
      foreignHostOwners.push({
        pid: manifest.transactionOwner.pid,
        hostname: manifest.transactionOwner.hostname,
        role: "transaction owner",
      });
    }
    if (validationOwnerStatus === "host-mismatch") {
      foreignHostOwners.push({
        pid: manifest.validationOwner.pid,
        hostname: manifest.validationOwner.hostname,
        role: "validation owner",
      });
    }
    if (foreignHostOwners.length > 0) {
      foreignHostTransactions.push({
        abandonedDirectory,
        foreignHostOwners: foreignHostOwners.map((owner) => ({
          ...owner,
          canonicalSources: manifestCanonicalSources,
        })),
      });
    }
  }

  if (foreignHostTransactions.length > 0) {
    throw new Error(formatForeignHostRecoveryError(foreignHostTransactions));
  }
  if (discoveryErrors.length > 0) {
    throw createAggregateError(
      "Could not safely discover all API typecheck recovery transactions.",
      discoveryErrors,
    );
  }

  return [...canonicalSources].sort().map(createLockEntry);
}

async function recoverAbandonedBackups({
  includeDisjoint = false,
  lockOwner = null,
} = {}) {
  const callerOwnsTransition = Boolean(lockOwner);
  let ownedLock = lockOwner ?? (await acquireTransitionLock(recoveryLockEntry));
  const disjointLockOwners = [];
  const recoveryHandoffPath =
    runRecoveryLockHandoffFixture &&
    process.env.API_TYPECHECK_TEST_RECOVERY_HANDOFF_PATH;
  const recoveryRescanFailurePath =
    (runRecoveryLockRescanFailureFixture &&
      process.env.API_TYPECHECK_TEST_RECOVERY_RESCAN_FAILURE_PATH) ||
    (runRecoveryLockMultiRescanFailureFixture &&
      process.env.API_TYPECHECK_TEST_RECOVERY_MULTI_RESCAN_FAILURE_PATH);
  let recoveryHandoffObserved = false;
  let recoveryRescanFailureObserved = false;
  let completed = false;
  let result;
  let recoveryError = null;
  try {
    if (includeDisjoint) {
      // Output locks are acquired before the recovery transition lock by
      // normal checks. Drop the transition lock while waiting for any
      // abandoned, disjoint output locks so two checks cannot deadlock.
      await releaseTransitionLock(ownedLock, recoveryLockEntry);
      ownedLock = null;

      const acquiredDisjointPaths = new Set();
      while (!ownedLock) {
        ownedLock = await acquireTransitionLock(recoveryLockEntry);
        const disjointLockEntries = await discoverDisjointRecoveryLockEntries();
        const recoveryCleanupSecondGroupHandoffPath =
          testRecoveryLockCleanup &&
          process.env.API_TYPECHECK_TEST_RECOVERY_CLEANUP_SECOND_GROUP_PATH;
        if (recoveryHandoffPath && !recoveryHandoffObserved) {
          recoveryHandoffObserved = true;
          await writeFile(recoveryHandoffPath, "discovery-complete\n", {
            flag: "wx",
          });
          await waitForFile(`${recoveryHandoffPath}.published`, null);
          await releaseTransitionLock(ownedLock, recoveryLockEntry);
          ownedLock = null;
          continue;
        }
        const missingLockEntries = disjointLockEntries.filter(
          ({ canonicalPath }) => !acquiredDisjointPaths.has(canonicalPath),
        );
        if (missingLockEntries.length === 0) {
          if (recoveryHandoffPath && acquiredDisjointPaths.size > 0) {
            const lockEntry = disjointLockOwners[0]?.entries[0];
            const currentOwner = lockEntry
              ? await readJson(lockEntry.lockOwnerPath).catch(() => null)
              : null;
            await writeFile(
              `${recoveryHandoffPath}.locked`,
              `${JSON.stringify({
                canonicalPath: lockEntry?.canonicalPath ?? null,
                owner: currentOwner,
              })}\n`,
              { flag: "wx" },
            );
          }
          break;
        }

        await releaseTransitionLock(ownedLock, recoveryLockEntry);
        ownedLock = null;
        const disjointLockOwner = await acquireLock(missingLockEntries);
        disjointLockOwners.push({
          owner: disjointLockOwner,
          entries: missingLockEntries,
        });
        if (
          testRecoveryLockCleanup &&
          !recoveryCleanupFailureInjected &&
          (!recoveryCleanupSecondGroupHandoffPath ||
            disjointLockOwners.length > 1)
        ) {
          recoveryCleanupFailureInjected = true;
          ownedLock = await acquireTransitionLock(recoveryLockEntry);
          throw new Error(
            "Recovery lock cleanup fixture failed after acquiring disjoint output locks",
          );
        }
        for (const { canonicalPath } of missingLockEntries) {
          acquiredDisjointPaths.add(canonicalPath);
        }
        if (
          recoveryCleanupSecondGroupHandoffPath &&
          disjointLockOwners.length === 1
        ) {
          await writeFile(
            recoveryCleanupSecondGroupHandoffPath,
            "first-group-locked\n",
            { flag: "wx" },
          );
          await waitForFile(
            `${recoveryCleanupSecondGroupHandoffPath}.published`,
            null,
          );
        }
        if (
          recoveryRescanFailurePath &&
          !recoveryRescanFailureObserved
        ) {
          recoveryRescanFailureObserved = true;
          await writeFile(
            recoveryRescanFailurePath,
            "first-batch-locked\n",
            { flag: "wx" },
          );
          await waitForFile(`${recoveryRescanFailurePath}.published`, null);
        }
      }
    }
    result = await recoverAbandonedBackupsUnlocked({ includeDisjoint });
    completed = true;
  } catch (error) {
    recoveryError = error;
  }

  const cleanupFailures = [];
  for (const [groupIndex, { owner, entries }] of disjointLockOwners.entries()) {
    try {
      await releaseLock(owner, entries);
    } catch (error) {
      cleanupFailures.push(
        createRecoveryCleanupFailure(
          `Failed to release recovery output-lock owner group ${groupIndex + 1} (owner token ${owner.token})`,
          error,
        ),
      );
    }
  }
  if ((!callerOwnsTransition || !completed) && ownedLock) {
    try {
      await releaseTransitionLock(ownedLock, recoveryLockEntry);
    } catch (error) {
      cleanupFailures.push(
        createRecoveryCleanupFailure(
          `Failed to release recovery transition-lock owner (owner token ${ownedLock.token})`,
          error,
        ),
      );
    }
    ownedLock = null;
  }

  if (recoveryError && cleanupFailures.length > 0) {
    throw createAggregateError(
      "API typecheck recovery failed and recovery lock cleanup also failed.",
      [recoveryError, ...cleanupFailures],
    );
  }
  if (recoveryError) {
    throw recoveryError;
  }
  if (cleanupFailures.length > 0) {
    throw createAggregateError(
      "API typecheck recovery lock cleanup failed.",
      cleanupFailures,
    );
  }
  return callerOwnsTransition ? ownedLock : result;
}

if (runInterruptedPublicationFixture) {
  const readyPath =
    process.env.API_TYPECHECK_INTERRUPTED_PUBLICATION_READY_PATH;
  if (!readyPath || lockedPaths.length !== 1) {
    throw new Error(
      "Interrupted publication fixture requires one generated path and a ready marker",
    );
  }

  const source = lockedPaths[0];
  const restoreBackup =
    process.env.API_TYPECHECK_INTERRUPTED_PUBLICATION_RESTORE_BACKUP === "1";
  const afterPromotion =
    process.env.API_TYPECHECK_INTERRUPTED_PUBLICATION_AFTER_PROMOTION === "1";
  const sourceEntry = createLockEntry(await canonicalizePath(source));
  const creatingDirectory = await mkdtemp(
    path.join(workspaceRoot, `${creatingBackupPrefix}interrupted-publication-`),
  );
  const activeDirectory = path.join(
    workspaceRoot,
    `${activeBackupPrefix}interrupted-publication-${randomUUID()}`,
  );
  const backupRelativePath = "backup/generated-output";
  const publisherOwner = await acquireLock([sourceEntry]);
  let transitionOwner;
  try {
    transitionOwner = await acquireTransitionLock(recoveryLockEntry);
    const backupPath = path.join(creatingDirectory, backupRelativePath);
    await mkdir(path.dirname(backupPath), { recursive: true });
    if (!afterPromotion) {
      await writeFile(backupPath, "staged generated output\n", { flag: "wx" });
    }
    await writeManifest(creatingDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(sourceEntry.canonicalPath)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: restoreBackup ? "validation-running" : "prepared",
      transactionOwner: publisherOwner,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, source),
          backupRelativePath,
          originalFingerprint: await fingerprint(source),
        },
      ],
    });
    if (afterPromotion || restoreBackup) {
      await rename(creatingDirectory, activeDirectory);
    }
    if (restoreBackup) {
      const nestedOutput = (await stat(source)).isDirectory();
      await rm(path.join(activeDirectory, backupRelativePath));
      await rename(source, path.join(activeDirectory, backupRelativePath));
      if (nestedOutput) {
        await createNestedPublicationOutput(source, true);
      } else {
        await writeFile(source, "conflicting partial output\n", { flag: "wx" });
        await chmod(source, 0o600);
      }
    }
    await writeFile(
      readyPath,
      `${JSON.stringify({ creatingDirectory, activeDirectory })}\n`,
      { flag: "wx" },
    );
    await new Promise(() => setInterval(() => {}, 1_000));
  } finally {
    if (transitionOwner) {
      await releaseTransitionLock(transitionOwner, recoveryLockEntry);
    }
    await releaseLock(publisherOwner, [sourceEntry]);
    await rm(creatingDirectory, { force: true, recursive: true });
    await rm(activeDirectory, { force: true, recursive: true });
  }
}

if (runInterruptedPublicationRecovery) {
  const recoveryOwner = await acquireLock();
  try {
    await recoverAbandonedBackups({ includeDisjoint: true });
  } finally {
    await releaseLock(recoveryOwner);
  }
  process.exit(0);
}

if (testRecoveryLockCleanup) {
  // Exercise the wrapper's non-Error branch independently of releaseLock,
  // which normally turns filesystem failures into diagnostic Error objects.
  const nonErrorCleanupFailure = "EACCES: injected lock-directory removal failure";
  const cleanupContext = "Failed to release recovery output-lock owner group 1";
  let nonErrorAggregate;
  try {
    throw nonErrorCleanupFailure;
  } catch (error) {
    nonErrorAggregate = createAggregateError(
      "API typecheck recovery lock cleanup failed.",
      [createRecoveryCleanupFailure(cleanupContext, error)],
    );
  }
  const nonErrorEntry = nonErrorAggregate.errors[0];
  if (
    !(nonErrorAggregate instanceof AggregateError) ||
    nonErrorAggregate.errors.length !== 1 ||
    !(nonErrorEntry instanceof Error) ||
    nonErrorEntry.message !== `${cleanupContext}:\n${nonErrorCleanupFailure}` ||
    nonErrorEntry.cause !== nonErrorCleanupFailure ||
    !Object.hasOwn(nonErrorEntry, "cause") ||
    !nonErrorAggregate.message.includes(`[1] ${nonErrorEntry.message}`) ||
    nonErrorEntry.lockDiagnostics.length !== 0 ||
    nonErrorAggregate.lockDiagnostics.length !== 0
  ) {
    throw new Error(
      "Non-Error cleanup failure lost its context, formatted detail, or exact cause",
      { cause: nonErrorAggregate },
    );
  }
  console.log(
    "Non-Error cleanup failure retained its readable aggregate entry and exact original cause.",
  );

  const fixtureRoot = await mkdtemp(
    path.join(workspaceRoot, ".api-typecheck-recovery-lock-cleanup-"),
  );
  const firstTransactionDirectory = path.join(
    workspaceRoot,
    `${activeBackupPrefix}recovery-lock-cleanup-first-${randomUUID()}`,
  );
  const secondCreatingDirectory = path.join(
    workspaceRoot,
    `${creatingBackupPrefix}recovery-lock-cleanup-second-${randomUUID()}`,
  );
  const secondTransactionDirectory = path.join(
    workspaceRoot,
    `${activeBackupPrefix}recovery-lock-cleanup-second-${randomUUID()}`,
  );
  const sourcePaths = ["first-output", "second-output"].map((name) =>
    path.join(fixtureRoot, name),
  );
  const lockEntries = await Promise.all(
    sourcePaths.map(async (source) =>
      createLockEntry(await canonicalizePath(source)),
    ),
  );
  recoveryCleanupReleaseFailurePath = lockEntries[0].canonicalPath;
  recoveryCleanupTransitionReleaseFailurePath = recoveryLockEntry.canonicalPath;
  const cleanupSecondGroupPath = path.join(fixtureRoot, "second-group-handoff");
  const cleanupPaths = [
    fixtureRoot,
    firstTransactionDirectory,
    secondCreatingDirectory,
    secondTransactionDirectory,
    ...sourcePaths,
    cleanupSecondGroupPath,
    `${cleanupSecondGroupPath}.published`,
  ];
  let publisherPromise;

  try {
    const [firstSource, secondSource] = sourcePaths;
    const [firstLockEntry, secondLockEntry] = lockEntries;
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(firstSource, "current 0\n", { flag: "wx" });
    await writeFile(secondSource, "current 1\n", { flag: "wx" });

    const firstBackupPath = path.join(
      firstTransactionDirectory,
      "backup/first-output",
    );
    await mkdir(path.dirname(firstBackupPath), { recursive: true });
    await writeFile(firstBackupPath, "recovered 0\n", { flag: "wx" });
    await writeManifest(firstTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(firstLockEntry.canonicalPath)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: null,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, firstSource),
          backupRelativePath: "backup/first-output",
          originalFingerprint: await fingerprint(firstSource),
        },
      ],
    });

    const secondBackupPath = path.join(
      secondCreatingDirectory,
      "backup/second-output",
    );
    await mkdir(path.dirname(secondBackupPath), { recursive: true });
    await writeFile(secondBackupPath, "recovered 1\n", { flag: "wx" });
    await writeManifest(secondCreatingDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(secondLockEntry.canonicalPath)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: null,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, secondSource),
          backupRelativePath: "backup/second-output",
          originalFingerprint: await fingerprint(secondSource),
        },
      ],
    });

    publisherPromise = (async () => {
      await waitForFile(cleanupSecondGroupPath, null);
      const publisherOwner = await acquireLock([secondLockEntry]);
      try {
        await rename(secondCreatingDirectory, secondTransactionDirectory);
        await writeFile(`${cleanupSecondGroupPath}.published`, "published\n", {
          flag: "wx",
        });
      } finally {
        await releaseLock(publisherOwner, [secondLockEntry]);
      }
    })();

    process.env.API_TYPECHECK_TEST_RECOVERY_CLEANUP_SECOND_GROUP_PATH =
      cleanupSecondGroupPath;
    let recoveryError;
    try {
      await recoverAbandonedBackups({ includeDisjoint: true });
    } catch (error) {
      recoveryError = error;
    }
    await publisherPromise;
    const recoveryErrors =
      recoveryError instanceof AggregateError ? [...recoveryError.errors] : [];
    const [
      originalRecoveryError,
      outputCleanupFailure,
      transitionCleanupFailure,
    ] = recoveryErrors;
    const outputLockDiagnostic = outputCleanupFailure?.lockDiagnostics?.[0];
    const transitionLockDiagnostic =
      transitionCleanupFailure?.lockDiagnostics?.[0];
    const aggregateLockDiagnostics = recoveryError?.lockDiagnostics ?? [];
    if (
      outputCleanupFailure?.lockDiagnostics?.length !== 1 ||
      transitionCleanupFailure?.lockDiagnostics?.length !== 1 ||
      outputLockDiagnostic?.schemaVersion !== 1 ||
      outputLockDiagnostic.phase !== "output-lock-release" ||
      outputLockDiagnostic.canonicalOutput !== firstLockEntry.canonicalPath ||
      outputLockDiagnostic.transition !== false ||
      outputLockDiagnostic.ownerStatus !== "live" ||
      outputLockDiagnostic.filesystemState?.lockDirectory?.remains !== false ||
      outputLockDiagnostic.filesystemState?.ownerFile?.remains !== false ||
      transitionLockDiagnostic?.schemaVersion !== 1 ||
      transitionLockDiagnostic.phase !== "transition-lock-release" ||
      transitionLockDiagnostic.canonicalOutput !==
        recoveryLockEntry.canonicalPath ||
      transitionLockDiagnostic.transition !== true ||
      transitionLockDiagnostic.ownerStatus !== "live" ||
      transitionLockDiagnostic.filesystemState?.lockDirectory?.remains !==
        false ||
      transitionLockDiagnostic.filesystemState?.ownerFile?.remains !== false ||
      aggregateLockDiagnostics.length !== 2 ||
      !aggregateLockDiagnostics.includes(outputLockDiagnostic) ||
      !aggregateLockDiagnostics.includes(transitionLockDiagnostic)
    ) {
      throw new Error(
        "Recovery aggregation did not preserve each lock cleanup diagnostic",
      );
    }
    if (
      !recoveryError?.message.includes(
        "Recovery lock cleanup fixture failed after acquiring disjoint output locks",
      ) ||
      recoveryErrors.length !== 3 ||
      !originalRecoveryError?.message.includes(
        "Recovery lock cleanup fixture failed after acquiring disjoint output locks",
      ) ||
      !outputCleanupFailure?.message.includes(
        "recovery output-lock owner group 1 (owner token ",
      ) ||
      !outputCleanupFailure.cause?.message.includes(
        "Recovery lock cleanup fixture release failed for",
      ) ||
      !transitionCleanupFailure?.message.includes(
        "recovery transition-lock owner (owner token ",
      ) ||
      !transitionCleanupFailure.cause?.message.includes(
        "Recovery lock cleanup fixture transition release failed for",
      ) ||
      !recoveryError.message.includes(
        "Recovery lock cleanup fixture release failed for",
      ) ||
      !recoveryError.message.includes(firstLockEntry.canonicalPath) ||
      !recoveryError.message.includes(
        "Recovery lock cleanup fixture transition release failed for",
      ) ||
      !recoveryError.message.includes(recoveryLockEntry.canonicalPath) ||
      !recoveryError.message.includes("recorded owner status: ") ||
      !recoveryError.message.includes("lock directory remained: ") ||
      !recoveryError.message.includes("owner file remained: ")
    ) {
      throw (
        recoveryError ??
        new Error(
          "Recovery lock cleanup fixture did not report the original failure and the first group's release failure",
        )
      );
    }
    if (
      !recoveryError.message.includes(
        "API typecheck recovery failed and recovery lock cleanup also failed.",
      )
    ) {
      throw (
        recoveryError ??
        new Error(
          "Recovery lock cleanup fixture did not report both the recovery and cleanup failures",
        )
      );
    }

    const lockDirectories = lockEntries.flatMap((lockEntry) => [
      lockEntry.lockDirectory,
      lockEntry.transitionLockDirectory,
    ]);
    lockDirectories.push(recoveryLockEntry.transitionLockDirectory);
    const lingeringLocks = (
      await Promise.all(
        lockDirectories.map(async (lockPath) =>
          (await exists(lockPath)) ? lockPath : null,
        ),
      )
    ).filter(Boolean);
    if (lingeringLocks.length > 0) {
      throw new Error(
        `Recovery failure left output or transition locks behind after multiple lock groups: ${lingeringLocks.join(", ")}`,
      );
    }

    delete process.env.API_TYPECHECK_TEST_RECOVERY_CLEANUP_SECOND_GROUP_PATH;
    await rm(cleanupSecondGroupPath, { force: true });
    await rm(`${cleanupSecondGroupPath}.published`, { force: true });
    // Keep the recovery injection consumed. Fail an output release and the
    // second output's transition release, not the recovery handoff itself.
    recoveryCleanupReleaseFailureInjected = false;
    recoveryCleanupTransitionReleaseFailureInjected = false;
    recoveryCleanupTransitionReleaseFailurePath = secondLockEntry.canonicalPath;
    let cleanupOnlyError;
    try {
      await recoverAbandonedBackups({ includeDisjoint: true });
    } catch (error) {
      cleanupOnlyError = error;
    }
    const cleanupOnlyFailure = cleanupOnlyError?.errors?.[0];
    const releaseError = cleanupOnlyFailure?.cause;
    const releaseDiagnosticError = releaseError?.errors?.[0];
    const originalReleaseError = releaseDiagnosticError?.cause;
    const transitionReleaseDiagnosticError = releaseError?.errors?.[1];
    const originalTransitionReleaseError =
      transitionReleaseDiagnosticError?.cause;
    const expectedReleaseMessage =
      `Recovery lock cleanup fixture release failed for ${firstLockEntry.canonicalPath}`;
    const expectedCleanupTransitionMessage =
      `Recovery lock cleanup fixture transition release failed for ${secondLockEntry.canonicalPath}`;
    if (
      !(cleanupOnlyError instanceof AggregateError) ||
      !cleanupOnlyError.message.startsWith(
        "API typecheck recovery lock cleanup failed.\n",
      ) ||
      cleanupOnlyError.errors.length !== 1 ||
      !cleanupOnlyFailure?.message.includes(
        "recovery output-lock owner group 1 (owner token ",
      ) ||
      !cleanupOnlyError.message.includes(cleanupOnlyFailure.message) ||
      !(releaseError instanceof AggregateError) ||
      releaseError.errors.length !== 2 ||
      !(originalReleaseError instanceof Error) ||
      originalReleaseError.message !== expectedReleaseMessage ||
      !(originalTransitionReleaseError instanceof Error) ||
      originalTransitionReleaseError.message !== expectedCleanupTransitionMessage ||
      !releaseError.message.includes(expectedReleaseMessage) ||
      !releaseError.message.includes(expectedCleanupTransitionMessage) ||
      releaseError.message.indexOf(expectedReleaseMessage) >=
        releaseError.message.indexOf(expectedCleanupTransitionMessage) ||
      releaseDiagnosticError?.lockDiagnostic?.phase !== "output-lock-release" ||
      releaseDiagnosticError.lockDiagnostic.canonicalOutput !==
        firstLockEntry.canonicalPath ||
      transitionReleaseDiagnosticError?.lockDiagnostic?.phase !==
        "transition-lock-release" ||
      transitionReleaseDiagnosticError.lockDiagnostic.canonicalOutput !==
        secondLockEntry.canonicalPath ||
      cleanupOnlyFailure.lockDiagnostics?.length !== 2 ||
      releaseError.lockDiagnostics?.length !== 2 ||
      cleanupOnlyError.lockDiagnostics.length !== 2 ||
      cleanupOnlyError.lockDiagnostics[0] !==
        releaseDiagnosticError.lockDiagnostic ||
      cleanupOnlyError.lockDiagnostics[1] !==
        transitionReleaseDiagnosticError.lockDiagnostic ||
      cleanupOnlyFailure.lockDiagnostics[0] !==
        releaseDiagnosticError.lockDiagnostic ||
      cleanupOnlyFailure.lockDiagnostics[1] !==
        transitionReleaseDiagnosticError.lockDiagnostic ||
      releaseError.lockDiagnostics[0] !== releaseDiagnosticError.lockDiagnostic ||
      releaseError.lockDiagnostics[1] !==
        transitionReleaseDiagnosticError.lockDiagnostic ||
      !recoveryCleanupReleaseFailureInjected ||
      !recoveryCleanupTransitionReleaseFailureInjected
    ) {
      throw new Error(
        "Cleanup-only recovery failure lost its owner group, ordered release errors, diagnostics, or original causes",
        { cause: cleanupOnlyError },
      );
    }
    if (
      (await exists(firstTransactionDirectory)) ||
      (await exists(secondTransactionDirectory))
    ) {
      throw new Error(
        "Recovery retry could not run after multiple disjoint lock cleanup failure",
      );
    }
    for (const [index, source] of sourcePaths.entries()) {
      if ((await readFile(source, "utf8")) !== `recovered ${index}\n`) {
        throw new Error(
          `Recovery retry did not restore abandoned output ${source}`,
        );
      }
    }
    for (const lockPath of lockDirectories) {
      if (await exists(lockPath)) {
        throw new Error(`Cleanup-only recovery left a lock behind: ${lockPath}`);
      }
    }
    await recoverAbandonedBackups({ includeDisjoint: true });

    // Keep the supplied owner throughout recovery: includeDisjoint would
    // release it and acquire a different transition owner before preflight.
    async function checkCallerOwnedRecovery(failBeforeRemoval) {
    await mkdir(firstTransactionDirectory, { recursive: true });
    const invalidManifestPath = path.join(
      firstTransactionDirectory,
      backupManifestName,
    );
    await writeFile(invalidManifestPath, "{");
    const callerOwner = await acquireTransitionLock(recoveryLockEntry);
    recoveryCleanupTransitionReleaseFailurePath = recoveryLockEntry.canonicalPath;
    recoveryCleanupTransitionReleaseFailureInjected = false;
    const removalError = failBeforeRemoval
      ? new Error("Injected transition lock removal failure before rm")
      : null;
    recoveryCleanupBeforeRemovalError = removalError;
    const ownerFileBefore = await readFile(recoveryLockEntry.transitionOwnerPath, "utf8");
    let callerRecoveryError;
    try {
      await recoverAbandonedBackups({ lockOwner: callerOwner });
    } catch (error) {
      callerRecoveryError = error;
    }
    const [callerOriginalError, callerCleanupFailure] =
      callerRecoveryError instanceof AggregateError
        ? callerRecoveryError.errors
        : [];
    const callerReleaseError = callerCleanupFailure?.cause;
    const callerDiagnostic = callerReleaseError?.lockDiagnostic;
    const expectedRecoveryMessage =
      `Cannot safely recover unrecognized API typecheck backup: ${firstTransactionDirectory}`;
    const expectedCleanupMessage =
      `Failed to release recovery transition-lock owner (owner token ${callerOwner.token})`;
    const expectedTransitionReleaseMessage =
      removalError?.message ??
      `Recovery lock cleanup fixture transition release failed for ${recoveryLockEntry.canonicalPath}`;
    if (
      !(callerRecoveryError instanceof AggregateError) ||
      callerRecoveryError.errors.length !== 2 ||
      callerOriginalError?.message !== expectedRecoveryMessage ||
      !callerCleanupFailure?.message.startsWith(expectedCleanupMessage) ||
      !(callerReleaseError?.cause instanceof Error) ||
      callerReleaseError.cause.message !== expectedTransitionReleaseMessage ||
      (failBeforeRemoval && callerReleaseError.cause !== removalError) ||
      !callerRecoveryError.message.startsWith(
        "API typecheck recovery failed and recovery lock cleanup also failed.",
      ) ||
      !callerRecoveryError.message.includes(expectedRecoveryMessage) ||
      !callerRecoveryError.message.includes(expectedCleanupMessage) ||
      !callerRecoveryError.message.includes(expectedTransitionReleaseMessage) ||
      callerDiagnostic?.phase !== "transition-lock-release" ||
      callerDiagnostic.canonicalOutput !== recoveryLockEntry.canonicalPath ||
      callerDiagnostic.transition !== true ||
      callerDiagnostic.ownerStatus !== "live" ||
      callerDiagnostic.filesystemState.lockDirectory.path !==
        recoveryLockEntry.transitionLockDirectory ||
      callerDiagnostic.filesystemState.ownerFile.path !==
        recoveryLockEntry.transitionOwnerPath ||
      callerDiagnostic.filesystemState.lockDirectory.remains !== failBeforeRemoval ||
      callerDiagnostic.filesystemState.ownerFile.remains !== failBeforeRemoval ||
      callerRecoveryError.lockDiagnostics?.length !== 1 ||
      callerRecoveryError.lockDiagnostics[0] !== callerDiagnostic ||
      recoveryCleanupTransitionReleaseFailureInjected !== !failBeforeRemoval
    ) {
      throw new Error(
        "Caller-owned recovery cleanup lost the supplied owner token, recovery error, or release cause",
        { cause: callerRecoveryError },
      );
    }
    if (failBeforeRemoval) {
      if (
        !(await exists(recoveryLockEntry.transitionLockDirectory)) ||
        (await readFile(recoveryLockEntry.transitionOwnerPath, "utf8")) !== ownerFileBefore
      ) {
        throw new Error("Failed removal changed the caller-owned lock or owner record");
      }
      // Disable both injections before exercising real owner-checked cleanup.
      recoveryCleanupBeforeRemovalError = null;
      recoveryCleanupTransitionReleaseFailureInjected = true;
      await releaseTransitionLock({ ...callerOwner, token: randomUUID() }, recoveryLockEntry);
      if (
        !(await exists(recoveryLockEntry.transitionLockDirectory)) ||
        (await readFile(recoveryLockEntry.transitionOwnerPath, "utf8")) !== ownerFileBefore
      ) {
        throw new Error("Cleanup with a different token changed the remaining lock");
      }
      await releaseTransitionLock(callerOwner, recoveryLockEntry);
    }
    for (const lockPath of [
      ...lockDirectories,
      recoveryLockEntry.transitionOwnerPath,
    ]) {
      if (await exists(lockPath)) {
        throw new Error(`Caller-owned recovery left a lock behind: ${lockPath}`);
      }
    }
    if ((await readFile(invalidManifestPath, "utf8")) !== "{") {
      throw new Error("Failed caller-owned recovery changed the invalid manifest");
    }
    for (const [index, source] of sourcePaths.entries()) {
      if ((await readFile(source, "utf8")) !== `recovered ${index}\n`) {
        throw new Error(`Caller-owned cleanup changed fixture output ${source}`);
      }
    }
    await rm(firstTransactionDirectory, { recursive: true });
    const retryOwner = await acquireTransitionLock(recoveryLockEntry);
    try {
      await recoverAbandonedBackups({ lockOwner: retryOwner });
      const retainedOwner = await readJson(recoveryLockEntry.transitionOwnerPath);
      if (retainedOwner.token !== retryOwner.token) {
        throw new Error("Successful retry did not retain its caller-owned lock");
      }
    } finally {
      await releaseTransitionLock(retryOwner, recoveryLockEntry);
    }
    if (await exists(recoveryLockEntry.transitionLockDirectory)) {
      throw new Error("Caller-owned recovery retry left its transition lock behind");
    }
    }
    await checkCallerOwnedRecovery(false);
    await checkCallerOwnedRecovery(true);
    console.log(
      "Caller-owned recovery preserved the exact owner token and both failure causes, checked remaining lock state, and retried safely without stale-lock cleanup.",
    );

    console.log(
      "Recovery reported combined failures and cleanup-only failures with the owner group and original cause intact, restored both outputs, released all locks, and a subsequent recovery completed without stale-lock cleanup.",
    );
  } finally {
    delete process.env.API_TYPECHECK_TEST_RECOVERY_CLEANUP_SECOND_GROUP_PATH;
    await publisherPromise?.catch(() => {});
    await Promise.all(
      [
        ...cleanupPaths,
        ...lockEntries.flatMap((lockEntry) => [
          lockEntry.lockDirectory,
          lockEntry.transitionLockDirectory,
        ]),
        recoveryLockEntry.transitionLockDirectory,
      ].map((cleanupPath) => rm(cleanupPath, { force: true, recursive: true })),
    );
  }
  process.exit(0);
}

if (runRecoveryLockHandoffFixture) {
  const handoffPath = process.env.API_TYPECHECK_TEST_RECOVERY_HANDOFF_PATH;
  const handoffSourcePath =
    process.env.API_TYPECHECK_TEST_RECOVERY_HANDOFF_SOURCE_PATH;
  if (!handoffPath || !handoffSourcePath || lockedPaths.length !== 1) {
    throw new Error(
      "Recovery lock handoff fixture requires one current path, one published path, and a handoff marker",
    );
  }

  const source = path.resolve(workspaceRoot, handoffSourcePath);
  const sourceEntry = createLockEntry(await canonicalizePath(source));
  const creatingDirectory = path.join(
    workspaceRoot,
    `${creatingBackupPrefix}handoff-${randomUUID()}`,
  );
  const transactionDirectory = path.join(
    workspaceRoot,
    `${activeBackupPrefix}handoff-${randomUUID()}`,
  );
  const backupRelativePath = "backup/generated-output";
  const backupPath = path.join(creatingDirectory, backupRelativePath);
  const originalContents = "current generated output\n";
  const recoveredContents = "recovered generated output\n";
  const callerOwnedHandoff =
    process.env.API_TYPECHECK_TEST_CALLER_OWNED_HANDOFF === "1";
  let publisherPromise;

  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, originalContents, { flag: "wx" });
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, recoveredContents, { flag: "wx" });
    const originalFingerprint = await fingerprint(source);

    publisherPromise = (async () => {
      await waitForFile(handoffPath, null);
      const publisherOwner = await acquireLock([sourceEntry]);
      try {
        await writeManifest(creatingDirectory, {
          version: 2,
          lockKey: createHash("sha256")
            .update(sourceEntry.canonicalPath)
            .digest("hex")
            .slice(0, 16),
          createdAt: new Date().toISOString(),
          phase: "backed-up",
          transactionOwner: null,
          validationOwner: null,
          paths: [
            {
              sourceRelativePath: path.relative(workspaceRoot, source),
              backupRelativePath,
              originalFingerprint,
            },
          ],
        });
        await rename(creatingDirectory, transactionDirectory);
        await writeFile(`${handoffPath}.published`, "published\n", {
          flag: "wx",
        });
      } finally {
        await releaseLock(publisherOwner, [sourceEntry]);
      }
    })();

    const callerOwner = callerOwnedHandoff
      ? await acquireTransitionLock(recoveryLockEntry)
      : null;
    const returnedOwner = await recoverAbandonedBackups({
      includeDisjoint: true,
      lockOwner: callerOwner,
    });
    await publisherPromise;

    if (callerOwnedHandoff) {
      const liveOwner = await readJson(recoveryLockEntry.transitionOwnerPath);
      if (
        !returnedOwner?.token ||
        returnedOwner.token === callerOwner.token ||
        JSON.stringify(returnedOwner) !== JSON.stringify(liveOwner)
      ) {
        throw new Error(
          "Caller-owned handoff did not return the newly acquired live transition owner",
        );
      }
      await releaseTransitionLock(callerOwner, recoveryLockEntry);
      if (
        (await readFile(recoveryLockEntry.transitionOwnerPath, "utf8")) !==
        `${JSON.stringify(liveOwner)}\n`
      ) {
        throw new Error("Releasing the supplied owner changed the returned owner");
      }
    }
    for (const lockPath of [
      sourceEntry.lockDirectory,
      sourceEntry.lockOwnerPath,
      sourceEntry.transitionLockDirectory,
      sourceEntry.transitionOwnerPath,
    ]) {
      if (await exists(lockPath)) {
        throw new Error(`Successful handoff left an output lock behind: ${lockPath}`);
      }
    }

    const lockObservation = await readJson(`${handoffPath}.locked`);
    if (
      lockObservation?.canonicalPath !== sourceEntry.canonicalPath ||
      lockObservation.owner?.paths?.length !== 1 ||
      lockObservation.owner.paths[0] !== sourceEntry.canonicalPath
    ) {
      throw new Error(
        "Recovery preflight did not observe the newly published transaction under its per-path lock",
      );
    }
    if (await exists(transactionDirectory)) {
      throw new Error(
        "Recovery left the lock-handoff transaction after preflight",
      );
    }
    if ((await readFile(source, "utf8")) !== recoveredContents) {
      throw new Error(
        "Recovery did not restore the transaction published during lock handoff",
      );
    }

    if (callerOwnedHandoff) {
      await releaseTransitionLock(returnedOwner, recoveryLockEntry);
      for (const lockPath of [
        recoveryLockEntry.transitionLockDirectory,
        recoveryLockEntry.transitionOwnerPath,
      ]) {
        if (await exists(lockPath)) {
          throw new Error(`Releasing the returned owner left a lock: ${lockPath}`);
        }
      }
      const replacementOwner = await acquireTransitionLock(recoveryLockEntry);
      try {
        const replacementContents = await readFile(
          recoveryLockEntry.transitionOwnerPath, "utf8",
        );
        await releaseTransitionLock(returnedOwner, recoveryLockEntry);
        if (
          (await readFile(recoveryLockEntry.transitionOwnerPath, "utf8")) !==
          replacementContents
        ) {
          throw new Error("Releasing the returned owner changed its replacement");
        }
      } finally {
        await releaseTransitionLock(replacementOwner, recoveryLockEntry);
      }
    }
    if (await exists(recoveryLockEntry.transitionLockDirectory)) {
      throw new Error("Successful handoff left the recovery transition lock behind");
    }

    console.log(
      callerOwnedHandoff
        ? "Caller-owned recovery returned the live replacement owner, released output locks, and allowed safe release without removing a later owner."
        : "Recovery rediscovered a transaction published during lock handoff and restored it only after acquiring its per-path lock.",
    );
  } finally {
    await publisherPromise?.catch(() => {});
    await rm(creatingDirectory, { force: true, recursive: true });
    await rm(transactionDirectory, { force: true, recursive: true });
    await rm(source, { force: true, recursive: true });
    await rm(sourceEntry.lockDirectory, { force: true, recursive: true });
    await rm(sourceEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
    await rm(recoveryLockEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
  }
  process.exit(0);
}

if (runRecoveryLockRescanFailureFixture) {
  const fixtureDirectory = process.env.API_TYPECHECK_TEST_RECOVERY_RESCAN_DIRECTORY;
  const rescanFailurePath =
    process.env.API_TYPECHECK_TEST_RECOVERY_RESCAN_FAILURE_PATH;
  if (
    !fixtureDirectory ||
    !rescanFailurePath ||
    lockedPaths.length !== 1
  ) {
    throw new Error(
      "Recovery lock rescan failure fixture requires one current path, a fixture directory, and a handoff marker",
    );
  }

  const sourceDirectory = path.resolve(workspaceRoot, fixtureDirectory);
  const firstSource = path.join(sourceDirectory, "first-output");
  const secondSource = path.join(sourceDirectory, "second-output");
  const firstTransactionDirectory = path.join(
    workspaceRoot,
    `${activeBackupPrefix}rescan-failure-first-${randomUUID()}`,
  );
  const secondCreatingDirectory = path.join(
    workspaceRoot,
    `${creatingBackupPrefix}rescan-failure-second-${randomUUID()}`,
  );
  const secondTransactionDirectory = path.join(
    workspaceRoot,
    `${activeBackupPrefix}rescan-failure-second-${randomUUID()}`,
  );
  const firstBackupRelativePath = "backup/first-output";
  const secondBackupRelativePath = "backup/second-output";
  const firstOriginalContents = "current first output\n";
  const secondOriginalContents = "current second output\n";
  const firstRecoveredContents = "recovered first output\n";
  const secondRecoveredContents = "recovered second output\n";
  let publisherPromise;

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(firstSource, firstOriginalContents, { flag: "wx" });
    await writeFile(secondSource, secondOriginalContents, { flag: "wx" });
    const firstSourceEntry = createLockEntry(
      await canonicalizePath(firstSource),
    );
    const secondSourceEntry = createLockEntry(
      await canonicalizePath(secondSource),
    );
    const firstBackupPath = path.join(
      firstTransactionDirectory,
      firstBackupRelativePath,
    );
    await mkdir(path.dirname(firstBackupPath), { recursive: true });
    await writeFile(firstBackupPath, firstRecoveredContents, { flag: "wx" });
    await writeManifest(firstTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(firstSourceEntry.canonicalPath)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: null,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, firstSource),
          backupRelativePath: firstBackupRelativePath,
          originalFingerprint: await fingerprint(firstSource),
        },
      ],
    });

    const secondBackupPath = path.join(
      secondCreatingDirectory,
      secondBackupRelativePath,
    );
    await mkdir(path.dirname(secondBackupPath), { recursive: true });
    await writeFile(secondBackupPath, secondRecoveredContents, { flag: "wx" });
    await writeManifest(secondCreatingDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(secondSourceEntry.canonicalPath)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: null,
      validationOwner: null,
      paths: null,
    });

    publisherPromise = (async () => {
      await waitForFile(rescanFailurePath, null);
      const publisherOwner = await acquireLock([secondSourceEntry]);
      try {
        await rename(secondCreatingDirectory, secondTransactionDirectory);
        await writeFile(`${rescanFailurePath}.published`, "published\n", {
          flag: "wx",
        });
      } finally {
        await releaseLock(publisherOwner, [secondSourceEntry]);
      }
    })();

    let recoveryError;
    try {
      await recoverAbandonedBackups({ includeDisjoint: true });
    } catch (error) {
      recoveryError = error;
    }
    await publisherPromise;

    if (
      !recoveryError?.message.includes("Invalid backup path list:") ||
      !recoveryError.message.includes(secondTransactionDirectory)
    ) {
      throw (
        recoveryError ??
        new Error(
          "Recovery unexpectedly completed after a malformed transaction was published during a later lock scan",
        )
      );
    }
    if ((await readFile(firstSource, "utf8")) !== firstOriginalContents) {
      throw new Error(
        "Recovery changed the earlier transaction before the later-scan failure was reported",
      );
    }

    const lockDirectories = [
      firstSourceEntry.lockDirectory,
      firstSourceEntry.transitionLockDirectory,
      secondSourceEntry.lockDirectory,
      secondSourceEntry.transitionLockDirectory,
      recoveryLockEntry.transitionLockDirectory,
    ];
    const lingeringLocks = (
      await Promise.all(
        lockDirectories.map(async (lockPath) =>
          (await exists(lockPath)) ? lockPath : null,
        ),
      )
    ).filter(Boolean);
    if (lingeringLocks.length > 0) {
      throw new Error(
        `Later-scan recovery failure left locks behind: ${lingeringLocks.join(", ")}`,
      );
    }

    await writeManifest(secondTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(secondSourceEntry.canonicalPath)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: null,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, secondSource),
          backupRelativePath: secondBackupRelativePath,
          originalFingerprint: await fingerprint(secondSource),
        },
      ],
    });
    delete process.env.API_TYPECHECK_TEST_RECOVERY_RESCAN_FAILURE_PATH;
    await rm(rescanFailurePath, { force: true });
    await rm(`${rescanFailurePath}.published`, { force: true });

    await recoverAbandonedBackups({ includeDisjoint: true });
    if (
      (await readFile(firstSource, "utf8")) !== firstRecoveredContents ||
      (await readFile(secondSource, "utf8")) !== secondRecoveredContents
    ) {
      throw new Error(
        "Recovery retry did not restore both transactions after the later-scan failure",
      );
    }
    if (
      (await exists(firstTransactionDirectory)) ||
      (await exists(secondTransactionDirectory))
    ) {
      throw new Error(
        "Recovery retry left a transaction behind after the later-scan failure",
      );
    }

    console.log(
      "Recovery released the earlier lock batch after a malformed transaction appeared during a later scan, and a retry recovered both transactions without stale-lock cleanup.",
    );
  } finally {
    await publisherPromise?.catch(() => {});
    await Promise.all(
      [
        firstSource,
        secondSource,
        firstTransactionDirectory,
        secondCreatingDirectory,
        secondTransactionDirectory,
        rescanFailurePath,
        `${rescanFailurePath}.published`,
      ].map((cleanupPath) =>
        rm(cleanupPath, { force: true, recursive: true }),
      ),
    );
  }
  process.exit(0);
}

if (runRecoveryLockMultiRescanFailureFixture) {
  const fixtureDirectory =
    process.env.API_TYPECHECK_TEST_RECOVERY_MULTI_RESCAN_DIRECTORY;
  const rescanFailurePath =
    process.env.API_TYPECHECK_TEST_RECOVERY_MULTI_RESCAN_FAILURE_PATH;
  if (!fixtureDirectory || !rescanFailurePath || lockedPaths.length !== 1) {
    throw new Error(
      "Recovery multi-rescan failure fixture requires one current path, a fixture directory, and a handoff marker",
    );
  }

  const sourceDirectory = path.resolve(workspaceRoot, fixtureDirectory);
  const transactionDefinitions = [
    {
      name: "first",
      sourceName: "first-output",
      transactionPrefix: "first",
      originalContents: "current first output\n",
      recoveredContents: "recovered first output\n",
    },
    {
      name: "other-valid",
      sourceName: "other-valid-output",
      transactionPrefix: "other-valid",
      originalContents: "current other valid output\n",
      recoveredContents: "recovered other valid output\n",
    },
    {
      name: "second",
      sourceName: "second-output",
      transactionPrefix: "second",
      originalContents: "current second output\n",
      recoveredContents: "recovered second output\n",
      malformed: true,
    },
    {
      name: "third",
      sourceName: "third-output",
      transactionPrefix: "third",
      originalContents: "current third output\n",
      recoveredContents: "recovered third output\n",
      malformed: true,
    },
  ];
  const transactions = transactionDefinitions.map((definition) => {
    const source = path.join(sourceDirectory, definition.sourceName);
    const transactionDirectory = path.join(
      workspaceRoot,
      `${activeBackupPrefix}multi-rescan-failure-${definition.transactionPrefix}-${randomUUID()}`,
    );
    const creatingDirectory = definition.malformed
      ? path.join(
          workspaceRoot,
          `${creatingBackupPrefix}multi-rescan-failure-${definition.transactionPrefix}-${randomUUID()}`,
        )
      : null;
    const backupRelativePath = `backup/${definition.sourceName}`;
    return {
      ...definition,
      source,
      sourceEntry: null,
      transactionDirectory,
      creatingDirectory,
      backupRelativePath,
    };
  });
  const cleanupPaths = [
    sourceDirectory,
    rescanFailurePath,
    `${rescanFailurePath}.published`,
    ...transactions.flatMap(({ transactionDirectory, creatingDirectory }) =>
      [transactionDirectory, creatingDirectory].filter(Boolean),
    ),
  ];
  let publisherPromise;

  try {
    await mkdir(sourceDirectory, { recursive: true });
    for (const transaction of transactions) {
      transaction.sourceEntry = createLockEntry(
        await canonicalizePath(transaction.source),
      );
      await writeFile(transaction.source, transaction.originalContents, {
        flag: "wx",
      });
      const backupPath = path.join(
        transaction.malformed
          ? transaction.creatingDirectory
          : transaction.transactionDirectory,
        transaction.backupRelativePath,
      );
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, transaction.recoveredContents, {
        flag: "wx",
      });
      await writeManifest(
        transaction.malformed
          ? transaction.creatingDirectory
          : transaction.transactionDirectory,
        {
          version: 2,
          lockKey: createHash("sha256")
            .update(transaction.sourceEntry.canonicalPath)
            .digest("hex")
            .slice(0, 16),
          createdAt: new Date().toISOString(),
          phase: "backed-up",
          transactionOwner: null,
          validationOwner: null,
          paths: transaction.malformed
            ? null
            : [
                {
                  sourceRelativePath: path.relative(
                    workspaceRoot,
                    transaction.source,
                  ),
                  backupRelativePath: transaction.backupRelativePath,
                  originalFingerprint: await fingerprint(transaction.source),
                },
              ],
        },
      );
    }

    const malformedTransactions = transactions.filter(
      ({ malformed }) => malformed,
    );
    const validTransactions = transactions.filter(({ malformed }) => !malformed);
    const protectedFingerprints = new Map();
    async function captureTransaction(transaction) {
      const protectedPaths = [
        transaction.source,
        path.join(transaction.transactionDirectory, transaction.backupRelativePath),
        path.join(transaction.transactionDirectory, backupManifestName),
        transaction.transactionDirectory,
      ];
      for (const protectedPath of protectedPaths) {
        const before = await fingerprint(protectedPath);
        if (before === null) {
          throw new Error(`Missing multi-rescan fixture path: ${protectedPath}`);
        }
        protectedFingerprints.set(protectedPath, before);
      }
    }
    for (const transaction of validTransactions) {
      await captureTransaction(transaction);
    }
    for (const { sourceEntry } of validTransactions) {
      multiRescanOutputReleaseFailures.add(sourceEntry.canonicalPath);
      multiRescanTransitionReleaseFailures.add(sourceEntry.canonicalPath);
    }
    publisherPromise = (async () => {
      await waitForFile(rescanFailurePath, null);
      const publisherOwner = await acquireLock(
        malformedTransactions.map(({ sourceEntry }) => sourceEntry),
      );
      try {
        for (const {
          creatingDirectory,
          transactionDirectory,
        } of malformedTransactions) {
          await rename(creatingDirectory, transactionDirectory);
        }
        // Recovery waits for the publication marker, so capture newly active
        // transactions before the failing discovery scan can inspect them.
        for (const transaction of malformedTransactions) {
          await captureTransaction(transaction);
        }
        await writeFile(`${rescanFailurePath}.published`, "published\n", {
          flag: "wx",
        });
      } finally {
        await releaseLock(
          publisherOwner,
          malformedTransactions.map(({ sourceEntry }) => sourceEntry),
        );
      }
    })();

    let recoveryError;
    try {
      await recoverAbandonedBackups({ includeDisjoint: true });
    } catch (error) {
      recoveryError = error;
    }
    await publisherPromise;

    const recoveryFailures =
      recoveryError instanceof AggregateError ? [...recoveryError.errors] : [];
    const discoveryFailure = recoveryFailures.find(
      (error) =>
        error instanceof AggregateError &&
        error.message.includes(
          "Could not safely discover all API typecheck recovery transactions.",
        ),
    );
    const cleanupFailure = recoveryFailures.find((error) =>
      error?.message.includes("recovery output-lock owner group 1 (owner token"),
    );
    if (
      !recoveryError?.message.includes(
        "Could not safely discover all API typecheck recovery transactions.",
      ) ||
      !recoveryError.message.includes(
        "API typecheck recovery failed and recovery lock cleanup also failed.",
      ) ||
      !discoveryFailure ||
      recoveryFailures.length !== 2 ||
      !(cleanupFailure?.cause instanceof AggregateError) ||
      cleanupFailure.cause.errors.length !== validTransactions.length * 2 ||
      discoveryFailure.errors.length !== malformedTransactions.length ||
      multiRescanOutputReleaseFailures.size !== 0 ||
      multiRescanTransitionReleaseFailures.size !== 0 ||
      validTransactions.some(({ sourceEntry }) =>
        ["output-lock-release", "transition-lock-release"].some((phase) => {
          const message = phase === "output-lock-release"
            ? `Recovery lock cleanup fixture release failed for ${sourceEntry.canonicalPath}`
            : `Recovery lock cleanup fixture transition release failed for ${sourceEntry.canonicalPath}`;
          const matchingErrors = cleanupFailure.cause.errors.filter(
            (error) =>
              error.cause?.message === message &&
              error.lockDiagnostic?.phase === phase &&
              error.lockDiagnostic?.canonicalOutput === sourceEntry.canonicalPath,
          );
          return matchingErrors.length !== 1 ||
            !recoveryError.message.includes(message) ||
            !recoveryError.lockDiagnostics?.includes(matchingErrors[0].lockDiagnostic);
        }),
      ) ||
      malformedTransactions.some(
        ({ transactionDirectory }) =>
          !recoveryError.message.includes(
            `Invalid backup path list: ${path.join(
              transactionDirectory,
              backupManifestName,
            )}`,
          ) || !discoveryFailure.errors.some(
            (error) => error.message.includes(transactionDirectory) &&
              error.message.includes("Invalid backup path list:"),
          ),
      )
    ) {
      throw (
        recoveryError ??
        new Error(
          "Recovery did not report every malformed transaction and every injected output and transition release failure",
        )
      );
    }

    for (const [protectedPath, before] of protectedFingerprints) {
      if (
        JSON.stringify(await fingerprint(protectedPath)) !== JSON.stringify(before)
      ) {
        throw new Error(
          `Recovery changed saved state before manifest repair: ${protectedPath}`,
        );
      }
    }

    const lockDirectories = [
      ...transactions.flatMap(({ sourceEntry }) => [
        sourceEntry.lockDirectory,
        sourceEntry.transitionLockDirectory,
      ]),
      recoveryLockEntry.transitionLockDirectory,
    ];
    const lingeringLocks = (
      await Promise.all(
        lockDirectories.map(async (lockPath) =>
          (await exists(lockPath)) ? lockPath : null,
        ),
      )
    ).filter(Boolean);
    if (lingeringLocks.length > 0) {
      throw new Error(
        `Multi-rescan recovery failure left output or transition locks behind: ${lingeringLocks.join(", ")}`,
      );
    }

    for (const transaction of malformedTransactions) {
      await writeManifest(transaction.transactionDirectory, {
        version: 2,
        lockKey: createHash("sha256")
          .update(transaction.sourceEntry.canonicalPath)
          .digest("hex")
          .slice(0, 16),
        createdAt: new Date().toISOString(),
        phase: "backed-up",
        transactionOwner: null,
        validationOwner: null,
        paths: [
          {
            sourceRelativePath: path.relative(
              workspaceRoot,
              transaction.source,
            ),
            backupRelativePath: transaction.backupRelativePath,
            originalFingerprint: await fingerprint(transaction.source),
          },
        ],
      });
    }
    delete process.env.API_TYPECHECK_TEST_RECOVERY_MULTI_RESCAN_FAILURE_PATH;
    await rm(rescanFailurePath, { force: true });
    await rm(`${rescanFailurePath}.published`, { force: true });

    await recoverAbandonedBackups({ includeDisjoint: true });
    for (const transaction of transactions) {
      if (
        (await readFile(transaction.source, "utf8")) !==
        transaction.recoveredContents
      ) {
        throw new Error(
          `Recovery retry did not restore ${transaction.name} after the multi-transaction later-scan failure`,
        );
      }
      if (await exists(transaction.transactionDirectory)) {
        throw new Error(
          `Recovery retry left the ${transaction.name} transaction behind after the multi-transaction later-scan failure`,
        );
      }
    }

    console.log(
      "Recovery reported every malformed transaction and all four injected output and transition release failures, preserved every source, backup, manifest, and active transaction directory before repair, released all locks, and a repaired retry recovered every transaction without stale-lock cleanup.",
    );
  } finally {
    await publisherPromise?.catch(() => {});
    await Promise.all(
      [
        ...cleanupPaths,
        ...transactions.flatMap(({ sourceEntry }) =>
          sourceEntry
            ? [
                sourceEntry.lockDirectory,
                sourceEntry.transitionLockDirectory,
              ]
            : [],
        ),
        recoveryLockEntry.transitionLockDirectory,
      ].map((cleanupPath) => rm(cleanupPath, { force: true, recursive: true })),
    );
  }
  process.exit(0);
}

if (testRecoveryLockHandoff) {
  for (const callerOwnedHandoff of [false, true]) {
    const testDirectory = await mkdtemp(
      path.join(workspaceRoot, ".api-typecheck-recovery-handoff-"),
    );
    const currentSourcePath = path.join(testDirectory, "current-output");
    const handoffSourcePath = path.join(testDirectory, "handoff-output");
    const handoffPath = path.join(testDirectory, "handoff");
    const child = runHarnessChild(["--run-recovery-lock-handoff-fixture"], {
      API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
      API_TYPECHECK_TEST_GENERATED_PATHS: currentSourcePath,
      API_TYPECHECK_TEST_RECOVERY_HANDOFF_PATH: handoffPath,
      API_TYPECHECK_TEST_RECOVERY_HANDOFF_SOURCE_PATH: handoffSourcePath,
      API_TYPECHECK_TEST_CALLER_OWNED_HANDOFF: callerOwnedHandoff ? "1" : "0",
    });
    try {
      await waitForChild(child, "Recovery lock handoff fixture");
    } finally {
      await rm(testDirectory, { force: true, recursive: true });
    }
  }
  process.exit(0);
}

if (testRecoveryLockRescanFailure) {
  const testDirectory = await mkdtemp(
    path.join(workspaceRoot, ".api-typecheck-recovery-rescan-failure-"),
  );
  const currentSourcePath = path.join(testDirectory, "current-output");
  const rescanFailurePath = path.join(testDirectory, "rescan-failure");
  const child = runHarnessChild(
    ["--run-recovery-lock-rescan-failure-fixture"],
    {
      API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
      API_TYPECHECK_TEST_GENERATED_PATHS: currentSourcePath,
      API_TYPECHECK_TEST_RECOVERY_RESCAN_DIRECTORY: testDirectory,
      API_TYPECHECK_TEST_RECOVERY_RESCAN_FAILURE_PATH: rescanFailurePath,
    },
  );
  try {
    await waitForChild(child, "Recovery lock rescan failure fixture");
  } finally {
    await rm(testDirectory, { force: true, recursive: true });
  }
  process.exit(0);
}

if (testRecoveryLockMultiRescanFailure) {
  const testDirectory = await mkdtemp(
    path.join(workspaceRoot, ".api-typecheck-recovery-multi-rescan-failure-"),
  );
  const currentSourcePath = path.join(testDirectory, "current-output");
  const rescanFailurePath = path.join(testDirectory, "rescan-failure");
  const child = runHarnessChild(
    ["--run-recovery-lock-multi-rescan-failure-fixture"],
    {
      API_TYPECHECK_LOCK_STALE_AFTER_MS: "1",
      API_TYPECHECK_TEST_GENERATED_PATHS: currentSourcePath,
      API_TYPECHECK_TEST_RECOVERY_MULTI_RESCAN_DIRECTORY: testDirectory,
      API_TYPECHECK_TEST_RECOVERY_MULTI_RESCAN_FAILURE_PATH: rescanFailurePath,
    },
  );
  try {
    await waitForChild(child, "Recovery multi-rescan failure fixture");
  } finally {
    await rm(testDirectory, { force: true, recursive: true });
  }
  process.exit(0);
}

async function terminateValidationChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await exited;
}

// Shared by the focused entry point and the native hosted recovery suite.
async function assertRecoveryOwnerAges() {
  const fixtureRoot = await mkdtemp(
    path.join(workspaceRoot, ".api-typecheck-owner-age-"),
  );
  const cleanupPaths = [fixtureRoot];
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const identity = await getProcessIdentity(child.pid);
    if (!identity || (process.platform !== "linux" &&
        !identity.startsWith(`${process.platform}:`))) {
      throw new Error("Owner-age fixture requires a native process identity");
    }
    const currentOwner = {
      pid: child.pid,
      hostname: os.hostname(),
      processIdentity: identity,
    };
    const timestampCases = [
      {
        name: "valid",
        createdAt: new Date(Date.now() - (2 * 86_400_000 + 3 * 3_600_000)).toISOString(),
        expectedAge: "owner age: 2 days 3 hours",
      },
      {
        name: "missing",
        expectedAge: "owner age: unavailable (missing or invalid createdAt)",
      },
      {
        name: "malformed",
        createdAt: "not-a-timestamp",
        expectedAge: "owner age: unavailable (missing or invalid createdAt)",
      },
      {
        name: "future",
        createdAt: new Date(Date.now() + 86_400_000).toISOString(),
        expectedAge: "owner age: unavailable (createdAt is in the future)",
      },
    ];
    const transactions = [];
    const blockerCases = [
      ...timestampCases.map((timestampCase) => ({ ...timestampCase, blocker: "reused" })),
      { name: "invalid-identity", blocker: "malformed" },
    ];
    for (const role of ["transaction owner", "validation owner"]) {
      for (const { name, createdAt, expectedAge, blocker } of blockerCases) {
        const source = path.join(fixtureRoot, `${blocker}-${role.replace(" ", "-")}-${name}`);
        const transactionDirectory = path.join(
          workspaceRoot,
          `${activeBackupPrefix}owner-age-${randomUUID()}`,
        );
        cleanupPaths.push(transactionDirectory);
        await writeFile(source, "protected current output\n", { flag: "wx" });
        await mkdir(path.join(transactionDirectory, "backup"), { recursive: true });
        await writeFile(path.join(transactionDirectory, "backup/output"), "protected backup\n");
        const owner = {
          ...currentOwner,
          processIdentity: blocker === "reused" ? `${identity}-previous` : "",
          token: randomUUID(),
          ...(createdAt === undefined ? {} : { createdAt }),
        };
        await writeManifest(transactionDirectory, {
          version: 2,
          lockKey: createHash("sha256").update(source).digest("hex").slice(0, 16),
          createdAt: new Date().toISOString(),
          phase: "backed-up",
          transactionOwner: role === "transaction owner" ? owner : null,
          validationOwner: role === "validation owner" ? owner : null,
          paths: [{
            sourceRelativePath: path.relative(workspaceRoot, source),
            backupRelativePath: "backup/output",
            originalFingerprint: await fingerprint(source),
          }],
        });
        const expectedLine = blocker === "reused"
          ? `${transactionDirectory} (${role}, ${expectedAge})`
          : `${transactionDirectory} (${role}: recorded owner process identity is invalid)`;
        transactions.push({ transactionDirectory, role, expectedAge, owner, expectedLine });
      }
    }
    const stagingDirectory = path.join(
      workspaceRoot,
      `${creatingBackupPrefix}owner-age-${randomUUID()}`,
    );
    cleanupPaths.push(stagingDirectory);
    await mkdir(stagingDirectory);
    await writeFile(path.join(stagingDirectory, "manifest.json.tmp"), '{"unfinished":');
    const before = await Promise.all(cleanupPaths.map(fingerprint));
    let recoveryError;
    try {
      await recoverAbandonedBackups({ includeDisjoint: true });
    } catch (error) {
      recoveryError = error;
    }
    const diagnostic = recoveryError?.message ?? "";
    if (!diagnostic.includes(
      "Refusing to recover API typecheck backups whose owner PIDs were reused",
    )) {
      throw new Error("Owner-age recovery did not reject reused owners");
    }
    for (const role of ["transaction owner", "validation owner"]) {
      if (!diagnostic.includes(
        `Refusing to recover API typecheck backups with malformed ${role} records:`,
      )) {
        throw new Error(`Owner-age recovery omitted the malformed ${role} blockers`);
      }
    }
    for (const { transactionDirectory, role, expectedAge, owner, expectedLine } of transactions) {
      if (!diagnostic.split("\n").includes(expectedLine)) {
        throw new Error(`Owner-age recovery omitted ${transactionDirectory}: ${role}, ${expectedAge}`);
      }
      if (diagnostic.includes(owner.token)) {
        throw new Error("Owner-age recovery exposed an owner token");
      }
    }
    const after = await Promise.all(cleanupPaths.map(fingerprint));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("Owner-age recovery changed protected outputs, backups, manifests, or staging");
    }
    if (child.exitCode !== null || child.signalCode !== null ||
        !(await isOwnerAlive(currentOwner))) {
      throw new Error("Owner-age recovery stopped the replacement process");
    }
    console.log("Recovery owner ages passed: combined PID-reuse and malformed-owner blockers, both roles, four timestamp cases, token redaction, protected files, and a surviving process.");
  } finally {
    try {
      await terminateValidationChild(child);
    } finally {
      await Promise.all(cleanupPaths.map((entry) =>
        rm(entry, { force: true, recursive: true }),
      ));
    }
  }
}

const lockOwner = await acquireLock();
const lockAcquiredAt = Date.now();
const lockEventPath = process.env.API_TYPECHECK_LOCK_EVENT_PATH;
const lockTestHoldMs = Number(process.env.API_TYPECHECK_LOCK_TEST_HOLD_MS ?? 0);
if (lockTestHoldMs > 0) {
  await sleep(lockTestHoldMs);
}

if (testRecoveryOwnerAge) {
  try {
    await assertRecoveryOwnerAges();
  } finally {
    await releaseLock(lockOwner);
  }
  process.exit(0);
}

if (testUnsafeRecoveryManifests) {
  if (
    testNativeProcessIdentityRecovery &&
    !["darwin", "win32"].includes(process.platform)
  ) {
    throw new Error(
      `Native process identity recovery requires macOS or Windows; received ${process.platform}`,
    );
  }
  if (testNativeProcessIdentityRecovery) {
    await testNativeRecoveryDiagnosticPublicationAtomicity();
  }
  await assertRecoveryOwnerAges();
  const fixtureRoot = await mkdtemp(
    path.join(workspaceRoot, ".api-typecheck-hostile-manifests-"),
  );
  const outsideSource = path.join(
    os.tmpdir(),
    `api-typecheck-hostile-source-${randomUUID()}`,
  );
  const fixtureCases = [
    {
      name: "workspace-traversal",
      expectedError: "Backup source path escapes the workspace",
      sourcePaths: [outsideSource],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, outsideSource),
          backupRelativePath: "backup/traversal-output",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "duplicate-source",
      expectedError: "Ambiguous duplicate backup source paths",
      sourcePaths: [path.join(fixtureRoot, "duplicate-output")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "duplicate-output"),
          ),
          backupRelativePath: "backup/duplicate-output-1",
          originalFingerprint: null,
        },
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "duplicate-output"),
          ),
          backupRelativePath: "backup/duplicate-output-2",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "duplicate-backup-destination",
      expectedError: "Ambiguous duplicate backup destinations",
      sourcePaths: [
        path.join(fixtureRoot, "duplicate-backup-output-1"),
        path.join(fixtureRoot, "duplicate-backup-output-2"),
      ],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "duplicate-backup-output-1"),
          ),
          backupRelativePath: "backup/shared-output",
          originalFingerprint: null,
        },
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "duplicate-backup-output-2"),
          ),
          backupRelativePath: "backup/shared-output",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "lock-key-mismatch",
      expectedError: "Backup path set does not match its recorded lock key",
      sourcePaths: [path.join(fixtureRoot, "lock-key-output")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "lock-key-output"),
          ),
          backupRelativePath: "backup/lock-key-output",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "backup-destination-traversal",
      expectedError: "Backup path escapes its transaction directory",
      sourcePaths: [path.join(fixtureRoot, "backup-traversal-output")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "backup-traversal-output"),
          ),
          backupRelativePath: `../${path.basename(fixtureRoot)}-escaped-backup-output`,
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "malformed-backup-path",
      expectedError: "Cannot safely recover invalid backup manifest",
      sourcePaths: [path.join(fixtureRoot, "malformed-backup-output")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "malformed-backup-output"),
          ),
          backupRelativePath: 42,
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "malformed-path-entry",
      expectedError: "Invalid workspace-relative source path",
      sourcePaths: [],
      manifestPaths: [null],
    },
    {
      name: "malformed-owner-missing-pid",
      expectedError:
        "Refusing to recover API typecheck backups with malformed transaction owner records",
      transactionOwner: {
        hostname: os.hostname(),
        processIdentity: null,
      },
      sourcePaths: [path.join(fixtureRoot, "malformed-owner-missing-pid")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "malformed-owner-missing-pid"),
          ),
          backupRelativePath: "backup/malformed-owner-missing-pid",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "malformed-owner-invalid-pid",
      expectedError:
        "Refusing to recover API typecheck backups with malformed transaction owner records",
      transactionOwner: {
        pid: "not-a-pid",
        hostname: os.hostname(),
        processIdentity: null,
      },
      sourcePaths: [path.join(fixtureRoot, "malformed-owner-invalid-pid")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "malformed-owner-invalid-pid"),
          ),
          backupRelativePath: "backup/malformed-owner-invalid-pid",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "malformed-owner-missing-hostname",
      expectedError:
        "Refusing to recover API typecheck backups with malformed transaction owner records",
      transactionOwner: {
        pid: process.pid,
        processIdentity: null,
      },
      sourcePaths: [path.join(fixtureRoot, "malformed-owner-missing-hostname")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "malformed-owner-missing-hostname"),
          ),
          backupRelativePath: "backup/malformed-owner-missing-hostname",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "malformed-owner-invalid-hostname",
      expectedError:
        "Refusing to recover API typecheck backups with malformed transaction owner records",
      transactionOwner: {
        pid: process.pid,
        hostname: 42,
        processIdentity: null,
      },
      sourcePaths: [path.join(fixtureRoot, "malformed-owner-invalid-hostname")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "malformed-owner-invalid-hostname"),
          ),
          backupRelativePath: "backup/malformed-owner-invalid-hostname",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "malformed-validation-owner-missing-hostname",
      expectedError:
        "Refusing to recover API typecheck backups with malformed validation owner records",
      validationOwnerFactory: ({ pid, processIdentity }) => ({
        pid,
        processIdentity,
      }),
      sourcePaths: [
        path.join(fixtureRoot, "malformed-validation-owner-missing-hostname"),
      ],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(
              fixtureRoot,
              "malformed-validation-owner-missing-hostname",
            ),
          ),
          backupRelativePath:
            "backup/malformed-validation-owner-missing-hostname",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "malformed-validation-owner-invalid-hostname",
      expectedError:
        "Refusing to recover API typecheck backups with malformed validation owner records",
      validationOwnerFactory: ({ pid, processIdentity }) => ({
        pid,
        hostname: 42,
        processIdentity,
      }),
      sourcePaths: [
        path.join(fixtureRoot, "malformed-validation-owner-invalid-hostname"),
      ],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(
              fixtureRoot,
              "malformed-validation-owner-invalid-hostname",
            ),
          ),
          backupRelativePath:
            "backup/malformed-validation-owner-invalid-hostname",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "foreign-host-owner",
      expectedError:
        "Refusing to recover API typecheck backups owned by another host",
      foreignHostLock: true,
      transactionOwner: {
        pid: process.pid,
        hostname: `${os.hostname()}-foreign`,
        processIdentity: "foreign-host-process",
        token: randomUUID(),
      },
      sourcePaths: [path.join(fixtureRoot, "foreign-host-output")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "foreign-host-output"),
          ),
          backupRelativePath: "backup/foreign-host-output",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "foreign-host-current-configured-output",
      expectedError:
        "Refusing to recover API typecheck backups owned by another host",
      configuredOutput: lockedPaths[0],
      checkForeignHostOwner: true,
      transactionOwner: {
        pid: process.pid,
        hostname: `${os.hostname()}-foreign-configured-output`,
        processIdentity: "foreign-host-process",
        token: randomUUID(),
      },
      sourcePaths: [lockedPaths[0]],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, lockedPaths[0]),
          backupRelativePath: "backup/current-configured-output",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "foreign-host-current-configured-multiple-outputs",
      expectedError:
        "Refusing to recover API typecheck backups owned by another host",
      configuredOutputs: lockedPaths.slice(0, 2),
      checkForeignHostOwner: true,
      transactionOwner: {
        pid: process.pid,
        hostname: `${os.hostname()}-foreign-configured-multiple-outputs`,
        processIdentity: "foreign-host-process",
        token: randomUUID(),
      },
      sourcePaths: lockedPaths.slice(0, 2),
      manifestPaths: lockedPaths.slice(0, 2).map((source, index) => ({
        sourceRelativePath: path.relative(workspaceRoot, source),
        backupRelativePath: `backup/current-configured-output-${index}`,
        originalFingerprint: null,
      })),
    },
    {
      name: "foreign-host-validation-owner-current-configured-output",
      expectedError:
        "Refusing to recover API typecheck backups owned by another host",
      configuredOutput: lockedPaths[0],
      checkForeignHostOwner: true,
      foreignHostLockOwner: "validation",
      validationOwnerFactory: ({ pid, processIdentity }) => ({
        pid,
        hostname: `${os.hostname()}-foreign-validation-configured-output`,
        processIdentity,
        token: randomUUID(),
      }),
      sourcePaths: [lockedPaths[0]],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, lockedPaths[0]),
          backupRelativePath: "backup/current-configured-validation-output",
          originalFingerprint: null,
        },
      ],
    },
    {
      name: "foreign-host-validation-owner",
      expectedError:
        "Refusing to recover API typecheck backups owned by another host",
      foreignHostLock: true,
      foreignHostLockOwner: "validation",
      validationOwnerFactory: ({ pid, processIdentity }) => ({
        pid,
        hostname: `${os.hostname()}-foreign-validation`,
        processIdentity,
        token: randomUUID(),
      }),
      sourcePaths: [path.join(fixtureRoot, "foreign-host-validation-output")],
      manifestPaths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            path.join(fixtureRoot, "foreign-host-validation-output"),
          ),
          backupRelativePath: "backup/foreign-host-validation-output",
          originalFingerprint: null,
        },
      ],
    },
  ];
  for (const [index, processIdentity] of invalidProcessIdentityValues.entries()) {
    const transactionName = `malformed-transaction-owner-process-identity-${index}`;
    const transactionSource = path.join(fixtureRoot, transactionName);
    fixtureCases.push({
      name: transactionName,
      expectedError:
        "Refusing to recover API typecheck backups with malformed transaction owner records",
      expectedReason: "transaction owner: recorded owner process identity is invalid",
      transactionOwnerFactory: (owner) => ({ ...owner, processIdentity }),
      sourcePaths: [transactionSource],
      manifestPaths: [{
        sourceRelativePath: path.relative(workspaceRoot, transactionSource),
        backupRelativePath: `backup/${transactionName}`,
        originalFingerprint: null,
      }],
    });
    const name = `malformed-validation-owner-process-identity-${index}`;
    const source = path.join(fixtureRoot, name);
    fixtureCases.push({
      name,
      expectedError:
        "Refusing to recover API typecheck backups with malformed validation owner records",
      expectedReason: "validation owner: recorded owner process identity is invalid",
      validationOwnerFactory: (owner) => ({ ...owner, processIdentity }),
      sourcePaths: [source],
      manifestPaths: [{
        sourceRelativePath: path.relative(workspaceRoot, source),
        backupRelativePath: `backup/${name}`,
        originalFingerprint: null,
      }],
    });
  }
  const validationChildren = new Set();
  const cleanupPaths = new Set([fixtureRoot, outsideSource]);
  const liveOwnerFixtureTargets = [];
  for (const target of lockedPaths) {
    try {
      if ((await stat(target)).isFile()) {
        liveOwnerFixtureTargets.push(target);
      }
    } catch {
      // A missing generated file cannot be used as a canonical live-owner fixture.
    }
  }

  async function createLiveOwnerFixtureSource(source, targetIndex) {
    if (liveOwnerFixtureTargets.length === 0) {
      throw new Error("Live-owner recovery fixture requires a generated file");
    }
    await symlink(
      liveOwnerFixtureTargets[targetIndex % liveOwnerFixtureTargets.length],
      source,
      "file",
    );
  }

  try {
    for (const fixture of fixtureCases) {
      const validationChild = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        {
          detached: process.platform !== "win32",
          stdio: "ignore",
          windowsHide: true,
        },
      );
      validationChildren.add(validationChild);
      const validationOwner = {
        pid: validationChild.pid,
        hostname: os.hostname(),
        processIdentity: await getProcessIdentity(validationChild.pid),
      };
      const validSource = path.join(
        fixtureRoot,
        `valid-before-${fixture.name}-output`,
      );
      await writeFile(validSource, `current valid ${fixture.name}\n`, {
        flag: "wx",
      });
      const validTransactionDirectory = path.join(
        workspaceRoot,
        `${activeBackupPrefix}batch-0-valid-${fixture.name}-${randomUUID()}`,
      );
      cleanupPaths.add(validTransactionDirectory);
      const validBackupRelativePath = "backup/valid-output";
      const validBackupPath = path.join(
        validTransactionDirectory,
        validBackupRelativePath,
      );
      await mkdir(path.dirname(validBackupPath), { recursive: true });
      await writeFile(validBackupPath, `restored valid ${fixture.name}\n`, {
        flag: "wx",
      });
      const validSourceRelativePath = path.relative(workspaceRoot, validSource);
      await writeManifest(validTransactionDirectory, {
        version: 2,
        lockKey: createHash("sha256")
          .update(validSource)
          .digest("hex")
          .slice(0, 16),
        createdAt: new Date().toISOString(),
        phase: "validation-running",
        transactionOwner: null,
        validationOwner,
        paths: [
          {
            sourceRelativePath: validSourceRelativePath,
            backupRelativePath: validBackupRelativePath,
            originalFingerprint: await fingerprint(validSource),
          },
        ],
      });
      const transactionDirectory = path.join(
        workspaceRoot,
        `${activeBackupPrefix}batch-1-hostile-${fixture.name}-${randomUUID()}`,
      );
      cleanupPaths.add(transactionDirectory);
      await mkdir(transactionDirectory, { recursive: true });
      const incompleteDirectory = path.join(
        workspaceRoot,
        `${creatingBackupPrefix}batch-0-unfinished-${fixture.name}-${randomUUID()}`,
      );
      cleanupPaths.add(incompleteDirectory);
      await mkdir(path.join(incompleteDirectory, "backup"), {
        recursive: true,
      });
      await writeFile(
        path.join(incompleteDirectory, "manifest.json.tmp"),
        '{"unfinished":',
        { flag: "wx" },
      );
      await writeFile(
        path.join(incompleteDirectory, "backup", "partial-output"),
        `unfinished staging output ${fixture.name}\n`,
        { flag: "wx" },
      );
      const createdBackupPaths = [];
      const configuredOutputs =
        fixture.configuredOutputs ??
        (fixture.configuredOutput ? [fixture.configuredOutput] : []);
      if (
        fixture.configuredOutputs &&
        new Set(await Promise.all(configuredOutputs.map(canonicalizePath))).size < 2
      ) {
        throw new Error("Multi-output recovery fixture requires two distinct configured outputs");
      }
      for (const [index, source] of fixture.sourcePaths.entries()) {
        if (!configuredOutputs.includes(source)) {
          await mkdir(path.dirname(source), { recursive: true });
          await writeFile(
            source,
            `generated output ${fixture.name} ${index}\n`,
            {
              flag: "wx",
            },
          );
        }
      }
      for (const [index, item] of fixture.manifestPaths.entries()) {
        if (!item || typeof item.backupRelativePath !== "string") {
          continue;
        }
        const backupPath = path.join(
          transactionDirectory,
          item.backupRelativePath,
        );
        cleanupPaths.add(backupPath);
        if (createdBackupPaths.includes(backupPath)) {
          continue;
        }
        await mkdir(path.dirname(backupPath), { recursive: true });
        await writeFile(backupPath, `backup ${fixture.name} ${index}\n`, {
          flag: "wx",
        });
        createdBackupPaths.push(backupPath);
      }
      const manifest = {
        version: 2,
        lockKey:
          fixture.name === "lock-key-mismatch"
            ? "0000000000000000"
            : createHash("sha256")
                .update([...fixture.sourcePaths].sort().join("\0"))
                .digest("hex")
                .slice(0, 16),
        createdAt: new Date().toISOString(),
        phase: "backed-up",
        transactionOwner: fixture.transactionOwnerFactory
          ? fixture.transactionOwnerFactory(validationOwner)
          : fixture.transactionOwner ?? null,
        validationOwner: fixture.validationOwnerFactory
          ? fixture.validationOwnerFactory(validationOwner)
          : null,
        paths: await Promise.all(
          fixture.manifestPaths.map(async (item) => ({
            ...item,
            ...(configuredOutputs.length > 0 && configuredOutputs.includes(
              path.resolve(workspaceRoot, item.sourceRelativePath ?? ""),
            )
              ? {
                  originalFingerprint: await fingerprint(
                    path.resolve(workspaceRoot, item.sourceRelativePath),
                  ),
                }
              : {}),
          })),
        ),
      };
      await writeManifest(transactionDirectory, manifest);
      let foreignHostLockEntry = null;
      if (fixture.foreignHostLock) {
        foreignHostLockEntry = createLockEntry(
          await canonicalizePath(fixture.sourcePaths[0]),
        );
        cleanupPaths.add(foreignHostLockEntry.lockDirectory);
        await mkdir(foreignHostLockEntry.lockDirectory);
        const foreignLockOwner =
          fixture.foreignHostLockOwner === "validation"
            ? manifest.validationOwner
            : fixture.transactionOwner;
        await writeFile(
          foreignHostLockEntry.lockOwnerPath,
          `${JSON.stringify(foreignLockOwner)}\n`,
          { flag: "wx" },
        );
      }
      const configuredOutputLockEntries = await Promise.all(
        configuredOutputs.map(async (source) =>
          createLockEntry(await canonicalizePath(source)),
        ),
      );
      const protectedPaths = [
        incompleteDirectory,
        validSource,
        validTransactionDirectory,
        ...fixture.sourcePaths,
        transactionDirectory,
        path.join(transactionDirectory, backupManifestName),
        ...createdBackupPaths,
        ...(foreignHostLockEntry
          ? [
              foreignHostLockEntry.lockDirectory,
              foreignHostLockEntry.lockOwnerPath,
            ]
          : []),
        ...configuredOutputLockEntries.flatMap((entry) => [
          entry.lockDirectory,
          entry.lockOwnerPath,
        ]),
      ];
      const before = await Promise.all(protectedPaths.map(fingerprint));

      let recoveryError;
      try {
        await recoverAbandonedBackups({ includeDisjoint: true });
      } catch (error) {
        recoveryError = error;
      }
      if (
        !recoveryError?.message.includes(fixture.expectedError) ||
        (fixture.expectedReason &&
          !recoveryError.message.includes(fixture.expectedReason)) ||
        !recoveryError.message.includes(transactionDirectory)
      ) {
        throw (
          recoveryError ??
          new Error(
            `Unsafe ${fixture.name} manifest was unexpectedly recovered`,
          )
        );
      }
      if (
        fixture.transactionOwnerFactory &&
        recoveryError.message.includes("malformed validation owner records")
      ) {
        throw new Error(
          `Unsafe ${fixture.name} recovery used the validation-owner diagnostic`,
        );
      }
      if (
        fixture.validationOwnerFactory &&
        recoveryError.message.includes("malformed transaction owner records")
      ) {
        throw new Error(
          `Unsafe ${fixture.name} recovery used the transaction-owner diagnostic`,
        );
      }
      if (
        fixture.expectedReason &&
        /reused|replaced/i.test(recoveryError.message)
      ) {
        throw new Error(
          `Unsafe ${fixture.name} recovery misreported malformed identity as PID reuse`,
        );
      }
      const after = await Promise.all(protectedPaths.map(fingerprint));
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(
          `Unsafe ${fixture.name} recovery changed staging, generated output, or an active transaction`,
        );
      }
      if (!(await isOwnerAlive(validationOwner))) {
        throw new Error(
          fixture.validationOwnerFactory
            ? `Unsafe ${fixture.name} recovery stopped the recorded validation-owner process before rejection`
            : `Unsafe ${fixture.name} recovery stopped the earlier valid transaction's validation before preflight completed`,
        );
      }
      if (fixture.foreignHostLock || fixture.checkForeignHostOwner) {
        const canonicalOutputs = (
          await Promise.all(fixture.sourcePaths.map(canonicalizePath))
        ).sort();
        const foreignOwner =
          fixture.foreignHostLockOwner === "validation"
            ? manifest.validationOwner
            : fixture.transactionOwner;
        for (const expectedDetail of [
          `owner PID: ${foreignOwner.pid}`,
          `hostname: ${foreignOwner.hostname}`,
          "owner age: unavailable (missing or invalid createdAt)",
          `canonical output: ${canonicalOutputs.join(", ")}`,
          `affected transaction: ${transactionDirectory}`,
          ...(fixture.foreignHostLockOwner === "validation"
            ? ["validation owner"]
            : []),
        ]) {
          if (!recoveryError.message.includes(expectedDetail)) {
            throw new Error(
              `Foreign-host recovery error omitted ${expectedDetail}`,
            );
          }
        }
        if (recoveryError.message.includes(foreignOwner.token)) {
          throw new Error(
            "Foreign-host recovery error exposed the owner token",
          );
        }
      }
      await terminateValidationChild(validationChild);
      validationChildren.delete(validationChild);
      await rm(validTransactionDirectory, { force: true, recursive: true });
      await rm(validSource, { force: true, recursive: true });
      await rm(transactionDirectory, { force: true, recursive: true });
      await rm(incompleteDirectory, { force: true, recursive: true });
      for (const source of fixture.sourcePaths) {
        if (!configuredOutputs.includes(source)) {
          await rm(source, { force: true, recursive: true });
        }
      }
    }

    const remoteValidationBatch = [];
    const mixedOwnerChildren = [];
    const mixedLocalOwners = [];
    for (const role of ["transaction", "validation"]) {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        {
          detached: process.platform !== "win32",
          stdio: "ignore",
          windowsHide: true,
        },
      );
      validationChildren.add(child);
      mixedOwnerChildren.push(child);
      const owner = {
        pid: child.pid,
        hostname: os.hostname(),
        processIdentity: await getProcessIdentity(child.pid),
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      if (!(await isOwnerAlive(owner))) {
        throw new Error(`Mixed-host fixture ${role} process is not alive`);
      }
      mixedLocalOwners.push(owner);
    }
    for (const index of [0, 1, 2]) {
      const source = path.join(fixtureRoot, `remote-validation-${index}-output`);
      const transactionDirectory = path.join(
        workspaceRoot,
        `${activeBackupPrefix}remote-validation-${index}-${randomUUID()}`,
      );
      cleanupPaths.add(source);
      cleanupPaths.add(transactionDirectory);
      await writeFile(source, `remote generated output ${index}\n`, { flag: "wx" });
      const canonicalSource = await canonicalizePath(source);
      const backupRelativePath = "backup/output";
      const backupPath = path.join(transactionDirectory, backupRelativePath);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, `remote original output ${index}\n`, { flag: "wx" });
      const validationOwner = {
        pid: index === 2 ? mixedLocalOwners[1].pid : process.pid + index,
        hostname: `${os.hostname()}-remote-validation-${index}`,
        processIdentity: index === 2
          ? mixedLocalOwners[1].processIdentity
          : `remote-process-${index}`,
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      const transactionOwner = index === 2 ? mixedLocalOwners[0] : null;
      await writeManifest(transactionDirectory, {
        version: 2,
        lockKey: createHash("sha256")
          .update(canonicalSource)
          .digest("hex")
          .slice(0, 16),
        createdAt: new Date().toISOString(),
        phase: "validation-running",
        transactionOwner,
        validationOwner,
        paths: [{
          sourceRelativePath: path.relative(workspaceRoot, source),
          backupRelativePath,
          originalFingerprint: await fingerprint(backupPath),
        }],
      });
      const outputLock = createLockEntry(canonicalSource);
      cleanupPaths.add(outputLock.lockDirectory);
      await mkdir(outputLock.lockDirectory);
      await writeFile(
        outputLock.lockOwnerPath,
        `${JSON.stringify(transactionOwner ?? validationOwner)}\n`,
        { flag: "wx" },
      );
      remoteValidationBatch.push({
        source, canonicalSource, transactionDirectory, backupPath,
        validationOwner, outputLock,
      });
    }
    const remoteBatchStaging = path.join(
      workspaceRoot,
      `${creatingBackupPrefix}remote-validation-${randomUUID()}`,
    );
    cleanupPaths.add(remoteBatchStaging);
    await mkdir(remoteBatchStaging);
    await writeFile(
      path.join(remoteBatchStaging, "manifest.json.tmp"),
      '{"unfinished":',
      { flag: "wx" },
    );
    const remoteBatchProtectedPaths = [
      remoteBatchStaging,
      ...lockedPaths,
      ...lockEntries.flatMap(({ lockDirectory, lockOwnerPath }) => [
        lockDirectory, lockOwnerPath,
      ]),
      ...remoteValidationBatch.flatMap(
        ({ source, transactionDirectory, backupPath, outputLock }) => [
          source, transactionDirectory, backupPath,
          outputLock.lockDirectory, outputLock.lockOwnerPath,
        ],
      ),
    ];
    const remoteBatchBefore = await Promise.all(
      remoteBatchProtectedPaths.map(fingerprint),
    );
    for (const [stage, recover] of [
      ["discovery", discoverDisjointRecoveryLockEntries],
      ["preflight", () => recoverAbandonedBackups({ includeDisjoint: true })],
    ]) {
      let recoveryError;
      try {
        await recover();
      } catch (error) {
        recoveryError = error;
      }
      const diagnostic = recoveryError?.message ?? "";
      if (!diagnostic.includes(
        "Refusing to recover API typecheck backups owned by another host:",
      )) {
        throw new Error(`Remote validation batch ${stage} did not refuse recovery`);
      }
      for (const { transactionDirectory, canonicalSource, validationOwner } of remoteValidationBatch) {
        const details = [
          `affected transaction: ${transactionDirectory}`,
          "validation owner",
          `owner PID: ${validationOwner.pid}`,
          `hostname: ${validationOwner.hostname}`,
          `canonical output: ${canonicalSource}`,
        ];
        if (!diagnostic.split("\n").some(
          (line) => details.every((detail) => line.includes(detail)),
        )) {
          throw new Error(
            `Remote validation batch ${stage} omitted or misattributed owner/output details for ${transactionDirectory}`,
          );
        }
        if (diagnostic.includes(validationOwner.token)) {
          throw new Error(`Remote validation batch ${stage} exposed an owner token`);
        }
      }
      const after = await Promise.all(remoteBatchProtectedPaths.map(fingerprint));
      if (JSON.stringify(after) !== JSON.stringify(remoteBatchBefore)) {
        throw new Error(
          `Remote validation batch ${stage} changed generated output, backups, transactions, staging, or locks before refusal`,
        );
      }
      for (const owner of mixedLocalOwners) {
        if (diagnostic.includes(owner.token)) {
          throw new Error(`Mixed-host ${stage} exposed an owner token`);
        }
        if (!(await isOwnerAlive(owner))) {
          throw new Error(`Mixed-host ${stage} stopped a recorded process`);
        }
      }
    }
    for (const child of mixedOwnerChildren) {
      await terminateValidationChild(child);
      validationChildren.delete(child);
    }
    await Promise.all([
      rm(remoteBatchStaging, { force: true, recursive: true }),
      ...remoteValidationBatch.flatMap(({ source, transactionDirectory, outputLock }) => [
        rm(source, { force: true, recursive: true }),
        rm(transactionDirectory, { force: true, recursive: true }),
        rm(outputLock.lockDirectory, { force: true, recursive: true }),
      ]),
    ]);

    const ownerBatchValidationOwner = {
      hostname: os.hostname(),
    };
    const ownerBatchFixtures = [
      {
        name: "owner-batch-0-valid",
        transactionOwner: null,
        validationOwner: ownerBatchValidationOwner,
        phase: "validation-running",
      },
      {
        name: "owner-batch-1-transaction-owner",
        transactionOwner: {
          hostname: os.hostname(),
          processIdentity: null,
        },
        validationOwner: null,
        phase: "backed-up",
        expectedDetails: [
          "transaction owner: recorded owner PID is missing or invalid",
        ],
      },
      {
        name: "owner-batch-2-validation-owner",
        transactionOwner: null,
        validationOwner: {
          ...ownerBatchValidationOwner,
          hostname: 42,
        },
        phase: "validation-running",
        expectedDetails: [
          "validation owner: recorded owner hostname is missing or invalid",
        ],
      },
      {
        name: "owner-batch-3-both-owners",
        transactionOwner: {
          pid: "not-a-pid",
          hostname: os.hostname(),
        },
        validationOwner: {
          ...ownerBatchValidationOwner,
          hostname: "",
        },
        phase: "validation-running",
        expectedDetails: [
          "transaction owner: recorded owner PID is missing or invalid",
          "validation owner: recorded owner hostname is missing or invalid",
        ],
      },
      {
        name: "owner-batch-4-validation-owner-missing-hostname",
        transactionOwner: null,
        validationOwner: {},
        phase: "validation-running",
        expectedDetails: [
          "validation owner: recorded owner hostname is missing or invalid",
        ],
      },
    ];
    for (const [index, processIdentity] of invalidProcessIdentityValues.entries()) {
      ownerBatchFixtures.push({
        name: `owner-batch-5-transaction-identity-${index}`,
        transactionOwner: null,
        transactionOwnerFactory: (owner) => ({ ...owner, processIdentity }),
        validationOwner: ownerBatchValidationOwner,
        phase: "validation-running",
        expectedDetails: [
          "transaction owner: recorded owner process identity is invalid",
        ],
      });
    }
    const ownerBatchProcesses = [];
    const ownerBatchTransactions = [];
    for (const fixture of ownerBatchFixtures) {
      if (fixture.validationOwner) {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1_000)"],
          {
            detached: process.platform !== "win32",
            stdio: "ignore",
            windowsHide: true,
          },
        );
        validationChildren.add(child);
        const owner = {
          pid: child.pid,
          hostname: os.hostname(),
          processIdentity: await getProcessIdentity(child.pid),
        };
        ownerBatchProcesses.push({ child, owner, name: fixture.name });
        fixture.validationOwner = {
          ...fixture.validationOwner,
          pid: owner.pid,
          processIdentity: owner.processIdentity,
        };
        if (fixture.transactionOwnerFactory) {
          fixture.transactionOwner = fixture.transactionOwnerFactory(owner);
        }
        if (!(await isOwnerAlive(owner))) {
          throw new Error(`Owner batch validation process did not start: ${fixture.name}`);
        }
      }
      const source = path.join(fixtureRoot, `${fixture.name}-output`);
      const transactionDirectory = path.join(
        workspaceRoot,
        `${activeBackupPrefix}${fixture.name}-${randomUUID()}`,
      );
      const backupRelativePath = `backup/${fixture.name}-output`;
      const backupPath = path.join(transactionDirectory, backupRelativePath);
      cleanupPaths.add(transactionDirectory);
      cleanupPaths.add(source);
      await writeFile(source, `generated output ${fixture.name}\n`, {
        flag: "wx",
      });
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, `backup ${fixture.name}\n`, {
        flag: "wx",
      });
      await writeManifest(transactionDirectory, {
        version: 2,
        lockKey: createHash("sha256")
          .update(source)
          .digest("hex")
          .slice(0, 16),
        createdAt: new Date().toISOString(),
        phase: fixture.phase,
        transactionOwner: fixture.transactionOwner,
        validationOwner: fixture.validationOwner,
        paths: [
          {
            sourceRelativePath: path.relative(workspaceRoot, source),
            backupRelativePath,
            originalFingerprint: await fingerprint(source),
          },
        ],
      });
      ownerBatchTransactions.push({
        ...fixture,
        source,
        transactionDirectory,
        backupPath,
      });
    }
    const ownerBatchIncompleteDirectory = path.join(
      workspaceRoot,
      `${creatingBackupPrefix}owner-batch-${randomUUID()}`,
    );
    cleanupPaths.add(ownerBatchIncompleteDirectory);
    await mkdir(path.join(ownerBatchIncompleteDirectory, "backup"), {
      recursive: true,
    });
    await writeFile(
      path.join(ownerBatchIncompleteDirectory, "manifest.json.tmp"),
      '{"unfinished":',
      { flag: "wx" },
    );
    await writeFile(
      path.join(ownerBatchIncompleteDirectory, "backup", "partial-output"),
      "unfinished owner-batch staging output\n",
      { flag: "wx" },
    );
    const ownerBatchOutputLockEntries = await Promise.all(
      ownerBatchTransactions.map(async ({ source }) =>
        createLockEntry(await canonicalizePath(source)),
      ),
    );
    const ownerBatchProtectedPaths = [
      ownerBatchIncompleteDirectory,
      ...ownerBatchTransactions.flatMap(
        ({ source, transactionDirectory, backupPath }) => [
          source,
          transactionDirectory,
          backupPath,
        ],
      ),
      ...lockEntries.flatMap(({ lockDirectory, lockOwnerPath }) => [
        lockDirectory,
        lockOwnerPath,
      ]),
      ...ownerBatchOutputLockEntries.flatMap(
        ({ lockDirectory, lockOwnerPath }) => [
          lockDirectory,
          lockOwnerPath,
        ],
      ),
    ];
    const ownerBatchBefore = await Promise.all(
      ownerBatchProtectedPaths.map(fingerprint),
    );
    let ownerBatchRecoveryError;
    try {
      await recoverAbandonedBackups({ includeDisjoint: true });
    } catch (error) {
      ownerBatchRecoveryError = error;
    }
    const ownerBatchDiagnostics = ownerBatchRecoveryError?.message ?? "";
    if (
      !ownerBatchDiagnostics.includes(
        "malformed transaction owner records",
      ) ||
      !ownerBatchDiagnostics.includes("malformed validation owner records") ||
      ownerBatchTransactions
        .filter(({ expectedDetails }) => expectedDetails)
        .some(
          ({ transactionDirectory, expectedDetails }) =>
            expectedDetails.some(
              (expectedDetail) =>
                !ownerBatchDiagnostics.split("\n").includes(
                  `${transactionDirectory} (${expectedDetail})`,
                ),
            ),
        )
    ) {
      throw (
        ownerBatchRecoveryError ??
        new Error(
          "Malformed owner batch was unexpectedly recovered or incompletely reported",
        )
      );
    }
    const ownerDiagnosticSections = new Map();
    let ownerDiagnosticRole;
    for (const line of ownerBatchDiagnostics.split("\n")) {
      const heading = line.match(
        /^Refusing to recover API typecheck backups with malformed (transaction owner|validation owner) records:$/,
      );
      if (heading) {
        ownerDiagnosticRole = heading[1];
        ownerDiagnosticSections.set(ownerDiagnosticRole, []);
      } else if (line.startsWith("Refusing to recover")) {
        ownerDiagnosticRole = undefined;
      } else if (ownerDiagnosticRole) {
        ownerDiagnosticSections.get(ownerDiagnosticRole).push(line);
      }
    }
    for (const { transactionDirectory, expectedDetails = [] } of ownerBatchTransactions) {
      for (const role of ["transaction owner", "validation owner"]) {
        const expectedLines = expectedDetails
          .filter((detail) => detail.startsWith(`${role}:`))
          .map((detail) => `${transactionDirectory} (${detail})`);
        const actualLines = (ownerDiagnosticSections.get(role) ?? [])
          .filter((line) => line.startsWith(`${transactionDirectory} (`));
        if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
          throw new Error(
            `Malformed owner batch misattributed ${transactionDirectory} under ${role}`,
          );
        }
      }
    }
    if (/reused|replaced/i.test(ownerBatchDiagnostics)) {
      throw new Error("Malformed owner batch misreported invalid identity as PID reuse");
    }
    const ownerBatchAfter = await Promise.all(
      ownerBatchProtectedPaths.map(fingerprint),
    );
    if (JSON.stringify(ownerBatchAfter) !== JSON.stringify(ownerBatchBefore)) {
      throw new Error(
        "Malformed owner batch changed validation staging, generated output, backups, transactions, or locks before reporting all owner records",
      );
    }
    for (const { child, owner, name } of ownerBatchProcesses) {
      if (
        child.exitCode !== null ||
        child.signalCode !== null ||
        !(await isOwnerAlive(owner))
      ) {
        throw new Error(
          `Malformed owner batch changed the recorded validation process for ${name} before completing preflight`,
        );
      }
    }
    for (const { child } of ownerBatchProcesses) {
      await terminateValidationChild(child);
      validationChildren.delete(child);
    }
    await Promise.all([
      ...ownerBatchTransactions.flatMap(
        ({ source, transactionDirectory }) => [
          rm(source, { force: true, recursive: true }),
          rm(transactionDirectory, { force: true, recursive: true }),
        ],
      ),
      rm(ownerBatchIncompleteDirectory, { force: true, recursive: true }),
    ]);

    const liveOwnerValidationChild = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      },
    );
    validationChildren.add(liveOwnerValidationChild);
    const liveOwnerValidationOwner = {
      pid: liveOwnerValidationChild.pid,
      hostname: os.hostname(),
      processIdentity: await getProcessIdentity(liveOwnerValidationChild.pid),
    };
    const liveTransactionOwnerChild = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      },
    );
    validationChildren.add(liveTransactionOwnerChild);
    const liveTransactionOwner = {
      pid: liveTransactionOwnerChild.pid,
      hostname: os.hostname(),
      processIdentity: await getProcessIdentity(liveTransactionOwnerChild.pid),
      createdAt: new Date(
        Date.now() - (2 * 86_400_000 + 3 * 3_600_000),
      ).toISOString(),
    };
    const metadataUnavailableOwnerChild = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      },
    );
    validationChildren.add(metadataUnavailableOwnerChild);
    const metadataUnavailableOwner = {
      pid: metadataUnavailableOwnerChild.pid,
      hostname: os.hostname(),
      processIdentity: null,
    };
    const metadataDisappearedOwnerChild = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      },
    );
    validationChildren.add(metadataDisappearedOwnerChild);
    const metadataDisappearedOwner = {
      pid: metadataDisappearedOwnerChild.pid,
      hostname: os.hostname(),
      processIdentity: await getProcessIdentity(
        metadataDisappearedOwnerChild.pid,
      ),
      createdAt: "not-a-timestamp",
    };
    if (!metadataDisappearedOwner.processIdentity) {
      throw new Error(
        "Could not record process identity for metadata-disappeared owner fixture",
      );
    }
    unavailableProcessIdentityPids.add(metadataDisappearedOwner.pid);
    if (
      (await getOwnerProcessIdentity(metadataDisappearedOwner.pid)) !== null
    ) {
      throw new Error(
        "Metadata-disappeared owner fixture still returned its recorded process identity",
      );
    }
    const reusedOwnerFixtures = [];
    for (const replacementIndex of [0, 1]) {
      const reusedOwnerChild = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        {
          detached: process.platform !== "win32",
          stdio: "ignore",
          windowsHide: true,
        },
      );
      validationChildren.add(reusedOwnerChild);
      const reusedOwnerCurrentIdentity = await getProcessIdentity(
        reusedOwnerChild.pid,
      );
      if (!reusedOwnerCurrentIdentity) {
        throw new Error(
          `Could not record process identity for PID-reuse owner fixture ${replacementIndex + 1}`,
        );
      }
      if (
        testNativeProcessIdentityRecovery &&
        !reusedOwnerCurrentIdentity.startsWith(`${process.platform}:`)
      ) {
        throw new Error(
          `PID-reuse owner fixture ${replacementIndex + 1} did not use the native ${process.platform} process identity probe`,
        );
      }
      const reusedOwner = {
        pid: reusedOwnerChild.pid,
        hostname: os.hostname(),
        processIdentity: `${reusedOwnerCurrentIdentity}-previous`,
        token: `pid-reuse-fixture-owner-${replacementIndex + 1}`,
        ...(replacementIndex === 0
          ? {
              createdAt: new Date(
                Date.now() - (2 * 86_400_000 + 3 * 3_600_000),
              ).toISOString(),
            }
          : {}),
      };
      const reusedOwnerCurrent = {
        ...reusedOwner,
        processIdentity: reusedOwnerCurrentIdentity,
      };
      if (await isOwnerAlive(reusedOwner)) {
        throw new Error(
          `PID-reuse owner fixture ${replacementIndex + 1} still matched the live replacement process`,
        );
      }
      reusedOwnerFixtures.push({
        child: reusedOwnerChild,
        owner: reusedOwner,
        current: reusedOwnerCurrent,
      });
    }
    const liveOwnerIncompleteDirectory = path.join(
      workspaceRoot,
      `${creatingBackupPrefix}live-owner-batch-0-${randomUUID()}`,
    );
    cleanupPaths.add(liveOwnerIncompleteDirectory);
    await mkdir(path.join(liveOwnerIncompleteDirectory, "backup"), {
      recursive: true,
    });
    await writeFile(
      path.join(liveOwnerIncompleteDirectory, "manifest.json.tmp"),
      '{"unfinished":',
      { flag: "wx" },
    );
    await writeFile(
      path.join(liveOwnerIncompleteDirectory, "backup", "partial-output"),
      "unfinished live-owner staging output\n",
      { flag: "wx" },
    );

    const unrelatedSource = path.join(
      fixtureRoot,
      "live-owner-unrelated-output",
    );
    await writeFile(unrelatedSource, "current unrelated generated output\n", {
      flag: "wx",
    });
    const unrelatedTransactionDirectory = path.join(
      workspaceRoot,
      `${activeBackupPrefix}live-owner-batch-0-unrelated-${randomUUID()}`,
    );
    cleanupPaths.add(unrelatedTransactionDirectory);
    const unrelatedBackupRelativePath = "backup/unrelated-output";
    const unrelatedBackupPath = path.join(
      unrelatedTransactionDirectory,
      unrelatedBackupRelativePath,
    );
    await mkdir(path.dirname(unrelatedBackupPath), { recursive: true });
    await writeFile(unrelatedBackupPath, "restored unrelated output\n", {
      flag: "wx",
    });
    await writeManifest(unrelatedTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(unrelatedSource)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "validation-running",
      transactionOwner: null,
      validationOwner: liveOwnerValidationOwner,
      paths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, unrelatedSource),
          backupRelativePath: unrelatedBackupRelativePath,
          originalFingerprint: await fingerprint(unrelatedSource),
        },
      ],
    });

    const liveOwnedSource = path.join(fixtureRoot, "live-owned-output");
    await createLiveOwnerFixtureSource(liveOwnedSource, 0);
    const liveOwnedTransactionDirectory = path.join(
      workspaceRoot,
      `${activeBackupPrefix}live-owner-batch-3-owned-${randomUUID()}`,
    );
    cleanupPaths.add(liveOwnedTransactionDirectory);
    const liveOwnedBackupRelativePath = "backup/live-owned-output";
    const liveOwnedBackupPath = path.join(
      liveOwnedTransactionDirectory,
      liveOwnedBackupRelativePath,
    );
    await mkdir(path.dirname(liveOwnedBackupPath), { recursive: true });
    await writeFile(liveOwnedBackupPath, "restored live-owned output\n", {
      flag: "wx",
    });
    await writeManifest(liveOwnedTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(liveOwnedSource)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: liveTransactionOwner,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, liveOwnedSource),
          backupRelativePath: liveOwnedBackupRelativePath,
          originalFingerprint: await fingerprint(liveOwnedSource),
        },
      ],
    });

    const metadataUnavailableSource = path.join(
      fixtureRoot,
      "metadata-unavailable-owner-output",
    );
    await createLiveOwnerFixtureSource(metadataUnavailableSource, 1);
    const metadataUnavailableTransactionDirectory = path.join(
      workspaceRoot,
      `${activeBackupPrefix}live-owner-batch-1-metadata-unavailable-${randomUUID()}`,
    );
    cleanupPaths.add(metadataUnavailableTransactionDirectory);
    const metadataUnavailableBackupRelativePath =
      "backup/metadata-unavailable-owner-output";
    const metadataUnavailableBackupPath = path.join(
      metadataUnavailableTransactionDirectory,
      metadataUnavailableBackupRelativePath,
    );
    await mkdir(path.dirname(metadataUnavailableBackupPath), {
      recursive: true,
    });
    await writeFile(
      metadataUnavailableBackupPath,
      "restored metadata-unavailable-owner output\n",
      { flag: "wx" },
    );
    await writeManifest(metadataUnavailableTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(metadataUnavailableSource)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: metadataUnavailableOwner,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            metadataUnavailableSource,
          ),
          backupRelativePath: metadataUnavailableBackupRelativePath,
          originalFingerprint: await fingerprint(metadataUnavailableSource),
        },
      ],
    });

    const metadataDisappearedSource = path.join(
      fixtureRoot,
      "metadata-disappeared-owner-output",
    );
    await createLiveOwnerFixtureSource(metadataDisappearedSource, 2);
    const metadataDisappearedTransactionDirectory = path.join(
      workspaceRoot,
      `${activeBackupPrefix}live-owner-batch-1-metadata-disappeared-${randomUUID()}`,
    );
    cleanupPaths.add(metadataDisappearedTransactionDirectory);
    const metadataDisappearedBackupRelativePath =
      "backup/metadata-disappeared-owner-output";
    const metadataDisappearedBackupPath = path.join(
      metadataDisappearedTransactionDirectory,
      metadataDisappearedBackupRelativePath,
    );
    await mkdir(path.dirname(metadataDisappearedBackupPath), {
      recursive: true,
    });
    await writeFile(
      metadataDisappearedBackupPath,
      "restored metadata-disappeared-owner output\n",
      { flag: "wx" },
    );
    await writeManifest(metadataDisappearedTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(metadataDisappearedSource)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: metadataDisappearedOwner,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            metadataDisappearedSource,
          ),
          backupRelativePath: metadataDisappearedBackupRelativePath,
          originalFingerprint: await fingerprint(metadataDisappearedSource),
        },
      ],
    });

    const reusedOwnerTransactions = [];
    for (const [replacementIndex, { owner }] of reusedOwnerFixtures.entries()) {
      const reusedOwnerSource = path.join(
        fixtureRoot,
        `reused-owner-${replacementIndex + 1}-output`,
      );
      await writeFile(
        reusedOwnerSource,
        `current reused-owner-${replacementIndex + 1} generated output\n`,
        { flag: "wx" },
      );
      const reusedOwnerTransactionDirectory = path.join(
        workspaceRoot,
        `${activeBackupPrefix}live-owner-batch-2-reused-${replacementIndex + 1}-${randomUUID()}`,
      );
      cleanupPaths.add(reusedOwnerTransactionDirectory);
      const reusedOwnerBackupRelativePath = `backup/reused-owner-${replacementIndex + 1}-output`;
      const reusedOwnerBackupPath = path.join(
        reusedOwnerTransactionDirectory,
        reusedOwnerBackupRelativePath,
      );
      const reusedValidationOwner =
        replacementIndex === 1
          ? {
              ...owner,
              createdAt: new Date(Date.now() + 60_000).toISOString(),
            }
          : null;
      await mkdir(path.dirname(reusedOwnerBackupPath), { recursive: true });
      await writeFile(
        reusedOwnerBackupPath,
        `restored reused-owner-${replacementIndex + 1} output\n`,
        { flag: "wx" },
      );
      await writeManifest(reusedOwnerTransactionDirectory, {
        version: 2,
        lockKey: createHash("sha256")
          .update(reusedOwnerSource)
          .digest("hex")
          .slice(0, 16),
        createdAt: new Date().toISOString(),
        phase: "backed-up",
        transactionOwner: owner,
        validationOwner: reusedValidationOwner,
        paths: [
          {
            sourceRelativePath: path.relative(workspaceRoot, reusedOwnerSource),
            backupRelativePath: reusedOwnerBackupRelativePath,
            originalFingerprint: await fingerprint(reusedOwnerSource),
          },
        ],
      });
      reusedOwnerTransactions.push({
        source: reusedOwnerSource,
        transactionDirectory: reusedOwnerTransactionDirectory,
        owners: [
          {
            role: "transaction owner",
            owner,
            expectedAge:
              replacementIndex === 0
                ? "owner age: 2 days 3 hours"
                : "owner age: unavailable (missing or invalid createdAt)",
          },
          ...(reusedValidationOwner
            ? [
                {
                  role: "validation owner",
                  owner: reusedValidationOwner,
                  expectedAge:
                    "owner age: unavailable (createdAt is in the future)",
                },
              ]
            : []),
        ],
      });
    }
    const reusedValidationOwnerSource = path.join(
      fixtureRoot,
      "reused-validation-owner-output",
    );
    await writeFile(
      reusedValidationOwnerSource,
      "current reused-validation-owner generated output\n",
      { flag: "wx" },
    );
    const reusedValidationOwnerTransactionDirectory = path.join(
      workspaceRoot,
      `${activeBackupPrefix}live-owner-batch-2-reused-validation-${randomUUID()}`,
    );
    cleanupPaths.add(reusedValidationOwnerTransactionDirectory);
    const reusedValidationOwnerBackupRelativePath =
      "backup/reused-validation-owner-output";
    const reusedValidationOwnerBackupPath = path.join(
      reusedValidationOwnerTransactionDirectory,
      reusedValidationOwnerBackupRelativePath,
    );
    await mkdir(path.dirname(reusedValidationOwnerBackupPath), {
      recursive: true,
    });
    await writeFile(
      reusedValidationOwnerBackupPath,
      "restored reused-validation-owner output\n",
      { flag: "wx" },
    );
    await writeManifest(reusedValidationOwnerTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(reusedValidationOwnerSource)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "validation-running",
      transactionOwner: null,
      validationOwner: {
        ...reusedOwnerFixtures[0].owner,
        createdAt: "not-a-timestamp",
      },
      paths: [
        {
          sourceRelativePath: path.relative(
            workspaceRoot,
            reusedValidationOwnerSource,
          ),
          backupRelativePath: reusedValidationOwnerBackupRelativePath,
          originalFingerprint: await fingerprint(reusedValidationOwnerSource),
        },
      ],
    });
    reusedOwnerTransactions.push({
      source: reusedValidationOwnerSource,
      transactionDirectory: reusedValidationOwnerTransactionDirectory,
      owners: [
        {
          role: "validation owner",
          owner: {
            ...reusedOwnerFixtures[0].owner,
            createdAt: "not-a-timestamp",
          },
          expectedAge: "owner age: unavailable (missing or invalid createdAt)",
        },
      ],
    });

    const liveOwnerProtectedPaths = [
      liveOwnerIncompleteDirectory,
      unrelatedSource,
      unrelatedTransactionDirectory,
      metadataDisappearedSource,
      metadataDisappearedTransactionDirectory,
      metadataUnavailableSource,
      metadataUnavailableTransactionDirectory,
      liveOwnedSource,
      liveOwnedTransactionDirectory,
      reusedValidationOwnerSource,
      reusedValidationOwnerTransactionDirectory,
      ...reusedOwnerTransactions.flatMap(
        ({ source, transactionDirectory }) => [source, transactionDirectory],
      ),
    ];
    const reusedOwnerTransactionDirectories = reusedOwnerTransactions.map(
      ({ transactionDirectory }) => transactionDirectory,
    );
    const liveOwnerTransactionDirectories = [
      liveOwnedTransactionDirectory,
      metadataUnavailableTransactionDirectory,
      metadataDisappearedTransactionDirectory,
    ];
    const liveOwnerBefore = await Promise.all(
      liveOwnerProtectedPaths.map(fingerprint),
    );
    let liveOwnerRecoveryError;
    try {
      await recoverAbandonedBackups({ includeDisjoint: true });
    } catch (error) {
      liveOwnerRecoveryError = error;
    }
    if (testNativeProcessIdentityRecovery) {
      await recordNativeProcessRecoveryDiagnostics({
        affectedTransactions: reusedOwnerTransactions,
        error:
          liveOwnerRecoveryError ??
          new Error("PID-reuse recovery unexpectedly completed"),
      });
    }
    if (
      !liveOwnerRecoveryError.message.includes(
        "Refusing to recover API typecheck backups whose owner PIDs were reused",
      ) ||
      reusedOwnerTransactionDirectories.some(
        (transactionDirectory) =>
          !liveOwnerRecoveryError.message.includes(transactionDirectory),
      ) ||
      liveOwnerTransactionDirectories.some(
        (transactionDirectory) =>
          !liveOwnerRecoveryError.message.includes(transactionDirectory),
      )
    ) {
      throw (
        liveOwnerRecoveryError ??
        new Error("PID-reuse recovery was unexpectedly allowed")
      );
    }
    for (const { transactionDirectory, owners } of reusedOwnerTransactions) {
      const transactionDiagnostic = liveOwnerRecoveryError.message
        .split("\n")
        .find((line) => line.includes(transactionDirectory));
      for (const { role, expectedAge } of owners) {
        if (!transactionDiagnostic?.includes(`${role}, ${expectedAge}`)) {
          throw new Error(
            `PID-reuse recovery error omitted ${role} age ${expectedAge} for ${transactionDirectory}`,
          );
        }
      }
    }
    for (const { owner } of reusedOwnerFixtures) {
      if (liveOwnerRecoveryError.message.includes(owner.token)) {
        throw new Error("PID-reuse recovery error exposed an owner token");
      }
    }
    const liveOwnerDetails = [
      [
        liveOwnedTransactionDirectory,
        liveTransactionOwner,
        "owner age: 2 days 3 hours",
      ],
      [
        metadataUnavailableTransactionDirectory,
        metadataUnavailableOwner,
        "owner age: unavailable (missing or invalid createdAt)",
      ],
      [
        metadataDisappearedTransactionDirectory,
        metadataDisappearedOwner,
        "owner age: unavailable (missing or invalid createdAt)",
      ],
    ];
    for (const [
      transactionDirectory,
      owner,
      expectedOwnerAge,
    ] of liveOwnerDetails) {
      const expectedOwnerDetails = `(owner PID: ${owner.pid}, hostname: ${owner.hostname}, transaction owner: yes, ${expectedOwnerAge})`;
      if (
        !liveOwnerRecoveryError.message.includes(
          `${transactionDirectory} ${expectedOwnerDetails}`,
        )
      ) {
        throw new Error(
          `Live-owner recovery error omitted recorded owner details for ${transactionDirectory}`,
        );
      }
    }
    const liveOwnerAfter = await Promise.all(
      liveOwnerProtectedPaths.map(fingerprint),
    );
    if (JSON.stringify(liveOwnerAfter) !== JSON.stringify(liveOwnerBefore)) {
      throw new Error(
        "Live-owner rejection changed staging, generated output, or an active transaction",
      );
    }
    if (!(await isOwnerAlive(liveOwnerValidationOwner))) {
      throw new Error(
        "Live-owner rejection stopped an unrelated transaction's validation before preflight completed",
      );
    }
    if (!(await isOwnerAlive(liveTransactionOwner))) {
      throw new Error(
        "Live-owner rejection stopped the process that still owns the rejected transaction",
      );
    }
    if (!(await isOwnerAlive(metadataUnavailableOwner))) {
      throw new Error(
        "Live-owner rejection stopped the process whose identity metadata was unavailable",
      );
    }
    if (!(await isOwnerAlive(metadataDisappearedOwner))) {
      throw new Error(
        "Live-owner rejection stopped the process whose recorded identity metadata disappeared",
      );
    }
    for (const [replacementIndex, { current }] of reusedOwnerFixtures.entries()) {
      if (!(await isOwnerAlive(current))) {
        throw new Error(
          `PID-reuse rejection stopped live replacement process ${replacementIndex + 1}`,
        );
      }
    }
    await terminateValidationChild(liveOwnerValidationChild);
    validationChildren.delete(liveOwnerValidationChild);
    await terminateValidationChild(liveTransactionOwnerChild);
    validationChildren.delete(liveTransactionOwnerChild);
    await terminateValidationChild(metadataUnavailableOwnerChild);
    validationChildren.delete(metadataUnavailableOwnerChild);
    await terminateValidationChild(metadataDisappearedOwnerChild);
    validationChildren.delete(metadataDisappearedOwnerChild);
    for (const { child } of reusedOwnerFixtures) {
      await terminateValidationChild(child);
      validationChildren.delete(child);
    }
    await Promise.all(
      liveOwnerProtectedPaths.map((protectedPath) =>
        rm(protectedPath, { force: true, recursive: true }),
      ),
    );

    const sharedSource = path.join(fixtureRoot, "cross-transaction-output");
    await writeFile(sharedSource, "current shared generated output\n", {
      flag: "wx",
    });
    const aliasedFixtureRoot = path.join(
      workspaceRoot,
      `.api-typecheck-hostile-alias-${randomUUID()}`,
    );
    cleanupPaths.add(aliasedFixtureRoot);
    await symlink(
      fixtureRoot,
      aliasedFixtureRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasedSharedSource = path.join(
      aliasedFixtureRoot,
      path.basename(sharedSource),
    );
    const incompleteDirectory = path.join(
      workspaceRoot,
      `${creatingBackupPrefix}cross-transaction-${randomUUID()}`,
    );
    cleanupPaths.add(incompleteDirectory);
    await mkdir(path.join(incompleteDirectory, "backup"), { recursive: true });
    await writeFile(
      path.join(incompleteDirectory, "backup", "partial-output"),
      "unfinished cross-transaction staging output\n",
      { flag: "wx" },
    );

    const validationChild = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      },
    );
    validationChildren.add(validationChild);
    const validationOwner = {
      pid: validationChild.pid,
      hostname: os.hostname(),
      processIdentity: await getProcessIdentity(validationChild.pid),
    };
    const conflictingTransactions = [];
    const conflictingBackups = [];
    for (const [label, claimedSource] of [
      ["first", sharedSource],
      ["second", aliasedSharedSource],
    ]) {
      const transactionDirectory = path.join(
        workspaceRoot,
        `${activeBackupPrefix}cross-transaction-${label}-${randomUUID()}`,
      );
      cleanupPaths.add(transactionDirectory);
      conflictingTransactions.push(transactionDirectory);
      const backupRelativePath = `backup/${label}-output`;
      const backupPath = path.join(transactionDirectory, backupRelativePath);
      conflictingBackups.push(backupPath);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, `${label} shared backup\n`, { flag: "wx" });
      await writeManifest(transactionDirectory, {
        version: 2,
        lockKey: createHash("sha256")
          .update(claimedSource)
          .digest("hex")
          .slice(0, 16),
        createdAt: new Date().toISOString(),
        phase: "validation-running",
        transactionOwner: null,
        validationOwner,
        paths: [
          {
            sourceRelativePath: path.relative(workspaceRoot, claimedSource),
            backupRelativePath,
            originalFingerprint: await fingerprint(sharedSource),
          },
        ],
      });
    }
    const protectedPaths = [
      incompleteDirectory,
      sharedSource,
      ...conflictingTransactions,
      ...conflictingBackups,
    ];
    const before = await Promise.all(protectedPaths.map(fingerprint));
    let recoveryError;
    try {
      await recoverAbandonedBackups({ includeDisjoint: true });
    } catch (error) {
      recoveryError = error;
    }
    if (
      !recoveryError?.message.includes(
        "Ambiguous generated sources across active API typecheck recovery transactions",
      ) ||
      !recoveryError.message.includes(sharedSource) ||
      !recoveryError.message.includes(aliasedSharedSource) ||
      conflictingTransactions.some(
        (transactionDirectory) =>
          !recoveryError.message.includes(transactionDirectory),
      )
    ) {
      throw (
        recoveryError ??
        new Error(
          "Cross-transaction source conflict was unexpectedly recovered",
        )
      );
    }
    const after = await Promise.all(protectedPaths.map(fingerprint));
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(
        "Cross-transaction conflict changed staging, generated output, backups, or active transactions",
      );
    }
    if (!(await isOwnerAlive(validationOwner))) {
      throw new Error(
        "Cross-transaction conflict stopped validation before batch preflight completed",
      );
    }
    await terminateValidationChild(validationChild);
    validationChildren.delete(validationChild);

    console.log(
      "Unsafe recovery manifests, live-owned transactions, and cross-transaction source conflicts were rejected without changing validation processes, unfinished staging, generated outputs, backups, or active transactions, and each error identified every transaction requiring inspection.",
    );
  } finally {
    await Promise.all(
      [...validationChildren].map((child) =>
        terminateValidationChild(child).catch(() => {}),
      ),
    );
    await Promise.all(
      [...cleanupPaths].map((cleanupPath) =>
        rm(cleanupPath, { force: true, recursive: true }),
      ),
    );
    await releaseLock(lockOwner);
  }
  process.exit(0);
}

let backupDirectory;
if (!expectValidationFailure) {
  const recoveryCleanupFixture = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--test-recovery-lock-cleanup"],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
    },
  );
  if (recoveryCleanupFixture.error || recoveryCleanupFixture.status !== 0) {
    const failureDetail = recoveryCleanupFixture.error
      ? recoveryCleanupFixture.error.message
      : `exit status ${recoveryCleanupFixture.status ?? `signal ${recoveryCleanupFixture.signal}`}`;
    throw new Error(
      `Multi-group recovery cleanup scenario was not preserved: ${failureDetail}`,
    );
  }
}

let transactionLockOwner = await acquireTransitionLock(recoveryLockEntry);
try {
  try {
    transactionLockOwner = await recoverAbandonedBackups({
      includeDisjoint: true,
      lockOwner: transactionLockOwner,
    });
    const creatingDirectory = await mkdtemp(
      path.join(workspaceRoot, creatingBackupPrefix),
    );
    const activeDirectory = path.join(
      workspaceRoot,
      `${activeBackupPrefix}${randomUUID()}`,
    );
    const originalFingerprints = new Map(
      await Promise.all(
        lockedPaths.map(async (source) => [source, await fingerprint(source)]),
      ),
    );
    const backupManifest = {
      version: 2,
      lockKey,
      createdAt: new Date().toISOString(),
      phase: "prepared",
      transactionOwner: lockOwner,
      validationOwner: null,
      paths: lockedPaths.map((source) => ({
        sourceRelativePath: path.relative(workspaceRoot, source),
        backupRelativePath: path.relative(workspaceRoot, source),
        originalFingerprint: originalFingerprints.get(source),
      })),
    };
    await writeManifest(creatingDirectory, backupManifest);
    await rename(creatingDirectory, activeDirectory);
    backupDirectory = activeDirectory;
  } catch (error) {
    await releaseLock(lockOwner);
    throw error;
  }
} finally {
  await releaseTransitionLock(transactionLockOwner, recoveryLockEntry);
}

try {
  const movedPaths = [];
  const originalFingerprints = new Map();
  for (const source of lockedPaths) {
    originalFingerprints.set(source, await fingerprint(source));
  }
  const backupManifest = await readJson(
    path.join(backupDirectory, backupManifestName),
  );

  let validationFailure;
  try {
    if (expectValidationFailure && (await exists(failureFixture))) {
      throw new Error(`Failure fixture already exists: ${failureFixture}`);
    }

    for (const source of lockedPaths) {
      if (await exists(source)) {
        const backupPath = path.join(
          backupDirectory,
          path.relative(workspaceRoot, source),
        );
        await mkdir(path.dirname(backupPath), { recursive: true });
        await rename(source, backupPath);
        movedPaths.push({ source, backupPath });
      }
    }
    backupManifest.phase = "backed-up";
    await writeManifest(backupDirectory, backupManifest);

    if (expectValidationFailure) {
      await writeFile(
        failureFixture,
        'const apiTypecheckRegressionFailure: never = "controlled failure";\n',
      );
    }

    const result = await runTrackedValidation(backupDirectory, backupManifest);
    if (result.code !== 0) {
      throw new Error(
        `API typecheck exited with status ${result.code ?? result.signal}`,
      );
    }

    if (!(await declarationsExist())) {
      throw new Error(
        "API typecheck succeeded without rebuilding all declarations",
      );
    }
  } catch (error) {
    validationFailure = error;
  } finally {
    for (const generatedPath of lockedPaths) {
      await rm(generatedPath, {
        force: true,
        recursive: true,
      });
    }

    for (const { source, backupPath } of movedPaths) {
      await rename(backupPath, source);
    }

    await rm(failureFixture, { force: true });
    await rm(backupDirectory, { force: true, recursive: true });
  }

  for (const [source, originalFingerprint] of originalFingerprints) {
    const restoredFingerprint = await fingerprint(source);
    if (
      JSON.stringify(restoredFingerprint) !==
      JSON.stringify(originalFingerprint)
    ) {
      throw new Error(`Generated output was not restored exactly: ${source}`);
    }
  }

  if (await exists(backupDirectory)) {
    throw new Error(
      `Temporary backup directory was not removed: ${backupDirectory}`,
    );
  }

  if (expectValidationFailure) {
    if (
      !validationFailure?.message.includes("API typecheck exited with status")
    ) {
      throw (
        validationFailure ?? new Error("API typecheck unexpectedly succeeded")
      );
    }

    if (await exists(failureFixture)) {
      throw new Error(`Failure fixture was not removed: ${failureFixture}`);
    }

    console.log(
      "API typecheck failure restored generated outputs and removed temporary backups successfully.",
    );
  } else {
    if (validationFailure) {
      throw validationFailure;
    }

    console.log(
      `API typecheck rebuilt missing declarations for ${declarationLibraries
        .map(({ name }) => name)
        .join(", ")} successfully.`,
    );
  }
} finally {
  const lockReleasedAt = await releaseLock(lockOwner);
  if (lockEventPath) {
    await writeFile(
      lockEventPath,
      `${JSON.stringify({
        acquiredAt: lockAcquiredAt,
        releasedAt: lockReleasedAt,
      })}\n`,
    );
  }
}
