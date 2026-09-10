import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
const testProcessIdentity = process.argv.includes("--test-process-identity");
const testNativeProcessIdentity = process.argv.includes(
  "--test-native-process-identity",
);
const testNativeProcessIdentityTimeout = process.argv.includes(
  "--test-native-process-identity-timeout",
);
const testNativeProcessIdentityDescendantLifecycle = process.argv.includes(
  "--test-native-process-identity-descendant-lifecycle",
);
const testUnsafeRecoveryManifests = process.argv.includes(
  "--test-unsafe-recovery-manifests",
);
const runValidationChild = process.argv.includes("--run-validation-child");
const collectNativeProcessDiagnostics = process.argv.includes(
  "--collect-native-process-diagnostics",
);
const nativeDiagnosticsDirectory =
  process.env.API_TYPECHECK_NATIVE_DIAGNOSTICS_DIR ??
  path.join(os.tmpdir(), "api-typecheck-native-process-diagnostics");
const lockStaleAfterMs = Number(
  process.env.API_TYPECHECK_LOCK_STALE_AFTER_MS ?? 30 * 60 * 1000,
);
const lockWaitTimeoutMs = Number(
  process.env.API_TYPECHECK_LOCK_WAIT_TIMEOUT_MS ?? 10 * 60 * 1000,
);
const processIdentityCommandTimeoutMs = 5_000;
const unavailableProcessIdentityPids = new Set();

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

async function collectNativeProcessDiagnosticsBundle() {
  try {
    await mkdir(nativeDiagnosticsDirectory, { recursive: true });
  } catch (error) {
    console.error(
      `[native diagnostics] Could not create ${nativeDiagnosticsDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const writeDiagnostic = async (fileName, contents) => {
    try {
      await writeFile(
        path.join(nativeDiagnosticsDirectory, fileName),
        contents,
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

if (collectNativeProcessDiagnostics) {
  await collectNativeProcessDiagnosticsBundle();
  process.exit(0);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
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
    process.exit(0);
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

async function getOwnerStatus(
  owner,
  {
    platform = process.platform,
    hostname = os.hostname(),
    getIdentity = getOwnerProcessIdentity,
    exists = processExists,
  } = {},
) {
  if (owner?.hostname !== hostname || !Number.isInteger(owner?.pid)) {
    return "dead";
  }
  if (!exists(owner.pid)) return "dead";
  const currentIdentity = await getIdentity(owner.pid);
  if (!owner.processIdentity || !currentIdentity) {
    return "live";
  }
  return currentIdentity === owner.processIdentity ? "live" : "reused";
}

async function testPerPathLockTakeover() {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "api-typecheck-lock-identity-"),
  );
  const testPaths = ["first", "later", "blocked", "live", "reused"].map(
    (name) => path.join(testDirectory, name),
  );
  const testEntries = await Promise.all(
    testPaths.map(async (testPath) =>
      createLockEntry(await canonicalizePath(testPath)),
    ),
  );
  const [firstEntry, laterEntry, blockedEntry, liveEntry, reusedEntry] =
    testEntries;
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
      )
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
      )
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
      )
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

if (testProcessIdentity) {
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
  console.log(
    "Platform process identities distinguish live, dead, replaced, legacy, and metadata-unavailable lock owners; per-path stale takeover reclaimed a later lock and cleaned up earlier locks after partial acquisition.",
  );
  process.exit(0);
}

if (testNativeProcessIdentity) {
  const platform = process.platform;
  const failureContext = `host=${process.env.API_TYPECHECK_NATIVE_TEST_HOST ?? platform} runtime=${process.version} platform=${platform}`;
  let phase = "identity";
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
      phase = "filesystem setup";
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

      phase = "transition locking";
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

      phase = "filesystem cleanup";
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
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await childExit.catch(() => {});
    }
  }
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

async function acquireTransitionLock(lockEntry = primaryLockEntry) {
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processIdentity: await getProcessIdentity(),
    createdAt: new Date().toISOString(),
  };

  while (true) {
    try {
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
        throw error;
      }

      const existingOwner = await readJson(lockEntry.transitionOwnerPath).catch(
        () => null,
      );
      const transitionStats = await stat(
        lockEntry.transitionLockDirectory,
      ).catch(() => null);
      if (!transitionStats) {
        continue;
      }
      const isStale =
        Date.now() - transitionStats.mtimeMs >
        Math.min(lockStaleAfterMs, 30_000);
      if (isStale && (await getOwnerStatus(existingOwner)) === "dead") {
        const staleDirectory = `${lockEntry.transitionLockDirectory}.stale-${randomUUID()}`;
        try {
          await rename(lockEntry.transitionLockDirectory, staleDirectory);
          const movedOwner = await readJson(
            path.join(staleDirectory, "owner.json"),
          ).catch(() => null);
          if (movedOwner?.token !== existingOwner?.token) {
            await rename(
              staleDirectory,
              lockEntry.transitionLockDirectory,
            ).catch(() => {});
            continue;
          }
          await rm(staleDirectory, { force: true, recursive: true });
        } catch (staleError) {
          if (staleError.code !== "ENOENT") {
            throw staleError;
          }
        }
      } else {
        await sleep(25);
      }
    }
  }
}

async function releaseTransitionLock(owner, lockEntry = primaryLockEntry) {
  const currentOwner = await readJson(lockEntry.transitionOwnerPath).catch(
    () => null,
  );
  if (currentOwner?.token === owner.token) {
    await rm(lockEntry.transitionLockDirectory, {
      force: true,
      recursive: true,
    });
  }
}

async function acquireLock(
  entries = lockEntries,
  { waitTimeoutMs = lockWaitTimeoutMs } = {},
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
            const existingOwner = await readJson(lockEntry.lockOwnerPath).catch(
              () => null,
            );
            const lockStats = await stat(lockEntry.lockDirectory).catch(
              () => null,
            );
            if (!lockStats) {
              continue;
            }
            const isStale = Date.now() - lockStats.mtimeMs > lockStaleAfterMs;
            if (isStale && (await getOwnerStatus(existingOwner)) === "dead") {
              await rm(lockEntry.lockDirectory, {
                force: true,
                recursive: true,
              });
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
          throw new Error(
            `Timed out waiting for API typecheck regression lock: ${lockEntry.lockDirectory}`,
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
  for (const lockEntry of entries) {
    const transitionOwner = await acquireTransitionLock(lockEntry);
    try {
      const currentOwner = await readJson(lockEntry.lockOwnerPath).catch(
        () => null,
      );
      if (currentOwner?.token === owner.token) {
        await rm(lockEntry.lockDirectory, { force: true, recursive: true });
      }
    } finally {
      await releaseTransitionLock(transitionOwner, lockEntry);
    }
  }
  return Date.now();
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
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Interrupted-run fixture exited before moving outputs");
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for interrupted-run fixture");
    }
    await sleep(25);
  }
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
    console.log(
      "A later API typecheck regression run recovered outputs abandoned by a forcibly terminated run.",
    );
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

const lockOwner = await acquireLock();
const lockAcquiredAt = Date.now();
const lockEventPath = process.env.API_TYPECHECK_LOCK_EVENT_PATH;
const lockTestHoldMs = Number(process.env.API_TYPECHECK_LOCK_TEST_HOLD_MS ?? 0);
if (lockTestHoldMs > 0) {
  await sleep(lockTestHoldMs);
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
  for (const library of declarationLibraries) {
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
    const ownerStatus = await getOwnerStatus(manifest.transactionOwner);
    if (ownerStatus === "live") {
      if (
        includeDisjoint &&
        !manifestCanonicalSources.some((source) =>
          canonicalLockedPaths.includes(source),
        )
      ) {
        return null;
      }
      return {
        abandonedDirectory,
        liveOwner: true,
      };
    }
    if (ownerStatus === "reused") {
      return {
        abandonedDirectory,
        reusedOwner: true,
      };
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
  for (const entry of activeEntries) {
    const abandonedBackup = await preflightAbandonedBackup(entry, {
      includeDisjoint,
    });
    if (abandonedBackup) {
      if (abandonedBackup.liveOwner) {
        liveOwnerTransactions.push(abandonedBackup.abandonedDirectory);
      } else if (abandonedBackup.reusedOwner) {
        reusedOwnerTransactions.push(abandonedBackup.abandonedDirectory);
      } else {
        abandonedBackups.push(abandonedBackup);
      }
    }
  }
  if (liveOwnerTransactions.length > 0 || reusedOwnerTransactions.length > 0) {
    const recoveryErrors = [];
    if (liveOwnerTransactions.length > 0) {
      recoveryErrors.push(
        "Refusing to recover API typecheck backups still owned by live runs:",
        ...liveOwnerTransactions.sort(),
      );
    }
    if (reusedOwnerTransactions.length > 0) {
      recoveryErrors.push(
        "Refusing to recover API typecheck backups whose owner PIDs were reused:",
        ...reusedOwnerTransactions.sort(),
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
    if (
      manifest.version === 2 &&
      (await getOwnerStatus(manifest.transactionOwner)) === "live"
    ) {
      continue;
    }

    const manifestPaths = await resolveManifestPaths(manifest, manifestPath);
    if (manifest.version !== 2) {
      // Legacy manifests can only be recovered when their lock key matches
      // this check's current path set, so the current locks already cover
      // them.
      continue;
    }

    for (const item of manifestPaths) {
      if (typeof item?.source !== "string") {
        throw new Error(
          `Cannot safely recover invalid backup manifest: ${manifestPath}`,
        );
      }
      const canonicalSource = await canonicalizePath(item.source);
      if (!canonicalLockedPaths.includes(canonicalSource)) {
        canonicalSources.add(canonicalSource);
      }
    }
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
  let completed = false;
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
        const disjointLockEntries =
          await discoverDisjointRecoveryLockEntries();
        const missingLockEntries = disjointLockEntries.filter(
          ({ canonicalPath }) => !acquiredDisjointPaths.has(canonicalPath),
        );
        if (missingLockEntries.length === 0) {
          break;
        }

        await releaseTransitionLock(ownedLock, recoveryLockEntry);
        ownedLock = null;
        const disjointLockOwner = await acquireLock(missingLockEntries);
        disjointLockOwners.push({
          owner: disjointLockOwner,
          entries: missingLockEntries,
        });
        for (const { canonicalPath } of missingLockEntries) {
          acquiredDisjointPaths.add(canonicalPath);
        }
      }
    }
    const result = await recoverAbandonedBackupsUnlocked({ includeDisjoint });
    completed = true;
    return callerOwnsTransition ? ownedLock : result;
  } finally {
    for (const { owner, entries } of disjointLockOwners) {
      await releaseLock(owner, entries);
    }
    if ((!callerOwnsTransition || !completed) && ownedLock) {
      await releaseTransitionLock(ownedLock, recoveryLockEntry);
    }
  }
}

if (testUnsafeRecoveryManifests) {
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
  ];
  const validationChildren = new Set();
  const cleanupPaths = new Set([fixtureRoot, outsideSource]);

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
      for (const [index, source] of fixture.sourcePaths.entries()) {
        await mkdir(path.dirname(source), { recursive: true });
        await writeFile(source, `generated output ${fixture.name} ${index}\n`, {
          flag: "wx",
        });
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
        transactionOwner: null,
        validationOwner: null,
        paths: fixture.manifestPaths,
      };
      await writeManifest(transactionDirectory, manifest);
      const before = await Promise.all(
        [
          incompleteDirectory,
          validSource,
          validTransactionDirectory,
          ...fixture.sourcePaths,
          transactionDirectory,
          ...createdBackupPaths,
        ].map(fingerprint),
      );

      let recoveryError;
      try {
        await recoverAbandonedBackups({ includeDisjoint: true });
      } catch (error) {
        recoveryError = error;
      }
      if (
        !recoveryError?.message.includes(fixture.expectedError) ||
        !recoveryError.message.includes(transactionDirectory)
      ) {
        throw (
          recoveryError ??
          new Error(
            `Unsafe ${fixture.name} manifest was unexpectedly recovered`,
          )
        );
      }
      const after = await Promise.all(
        [
          incompleteDirectory,
          validSource,
          validTransactionDirectory,
          ...fixture.sourcePaths,
          transactionDirectory,
          ...createdBackupPaths,
        ].map(fingerprint),
      );
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(
          `Unsafe ${fixture.name} recovery changed staging, generated output, or an active transaction`,
        );
      }
      if (!(await isOwnerAlive(validationOwner))) {
        throw new Error(
          `Unsafe ${fixture.name} recovery stopped the earlier valid transaction's validation before preflight completed`,
        );
      }
      await terminateValidationChild(validationChild);
      validationChildren.delete(validationChild);
      await rm(validTransactionDirectory, { force: true, recursive: true });
      await rm(validSource, { force: true, recursive: true });
      await rm(transactionDirectory, { force: true, recursive: true });
      await rm(incompleteDirectory, { force: true, recursive: true });
      for (const source of fixture.sourcePaths) {
        await rm(source, { force: true, recursive: true });
      }
    }

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
        "Could not record process identity for PID-reuse owner fixture",
      );
    }
    const reusedOwner = {
      pid: reusedOwnerChild.pid,
      hostname: os.hostname(),
      processIdentity: `${reusedOwnerCurrentIdentity}-previous`,
    };
    const reusedOwnerCurrent = {
      ...reusedOwner,
      processIdentity: reusedOwnerCurrentIdentity,
    };
    if (await isOwnerAlive(reusedOwner)) {
      throw new Error(
        "PID-reuse owner fixture still matched the live replacement process",
      );
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
    await writeFile(liveOwnedSource, "current live-owned generated output\n", {
      flag: "wx",
    });
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
    await writeFile(
      metadataUnavailableSource,
      "current metadata-unavailable-owner generated output\n",
      { flag: "wx" },
    );
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
    await writeFile(
      metadataDisappearedSource,
      "current metadata-disappeared-owner generated output\n",
      { flag: "wx" },
    );
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

    const reusedOwnerSource = path.join(fixtureRoot, "reused-owner-output");
    await writeFile(
      reusedOwnerSource,
      "current reused-owner generated output\n",
      { flag: "wx" },
    );
    const reusedOwnerTransactionDirectory = path.join(
      workspaceRoot,
      `${activeBackupPrefix}live-owner-batch-2-reused-${randomUUID()}`,
    );
    cleanupPaths.add(reusedOwnerTransactionDirectory);
    const reusedOwnerBackupRelativePath = "backup/reused-owner-output";
    const reusedOwnerBackupPath = path.join(
      reusedOwnerTransactionDirectory,
      reusedOwnerBackupRelativePath,
    );
    await mkdir(path.dirname(reusedOwnerBackupPath), { recursive: true });
    await writeFile(reusedOwnerBackupPath, "restored reused-owner output\n", {
      flag: "wx",
    });
    await writeManifest(reusedOwnerTransactionDirectory, {
      version: 2,
      lockKey: createHash("sha256")
        .update(reusedOwnerSource)
        .digest("hex")
        .slice(0, 16),
      createdAt: new Date().toISOString(),
      phase: "backed-up",
      transactionOwner: reusedOwner,
      validationOwner: null,
      paths: [
        {
          sourceRelativePath: path.relative(workspaceRoot, reusedOwnerSource),
          backupRelativePath: reusedOwnerBackupRelativePath,
          originalFingerprint: await fingerprint(reusedOwnerSource),
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
      reusedOwnerSource,
      reusedOwnerTransactionDirectory,
    ];
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
    if (
      !liveOwnerRecoveryError.message.includes(
        "Refusing to recover API typecheck backups whose owner PIDs were reused",
      ) ||
      !liveOwnerRecoveryError.message.includes(reusedOwnerTransactionDirectory) ||
      liveOwnerTransactionDirectories.some((transactionDirectory) =>
        liveOwnerRecoveryError.message.includes(transactionDirectory),
      )
    ) {
      throw (
        liveOwnerRecoveryError ??
        new Error("PID-reuse recovery was unexpectedly allowed")
      );
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
    if (!(await isOwnerAlive(reusedOwnerCurrent))) {
      throw new Error(
        "PID-reuse rejection stopped the live replacement process",
      );
    }
    await terminateValidationChild(liveOwnerValidationChild);
    validationChildren.delete(liveOwnerValidationChild);
    await terminateValidationChild(liveTransactionOwnerChild);
    validationChildren.delete(liveTransactionOwnerChild);
    await terminateValidationChild(metadataUnavailableOwnerChild);
    validationChildren.delete(metadataUnavailableOwnerChild);
    await terminateValidationChild(metadataDisappearedOwnerChild);
    validationChildren.delete(metadataDisappearedOwnerChild);
    await terminateValidationChild(reusedOwnerChild);
    validationChildren.delete(reusedOwnerChild);
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
