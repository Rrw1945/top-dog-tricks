---
name: Generated-output harness locking
description: Mutual-exclusion rules for checks that temporarily move shared generated files.
---

The exclusive interval must include initial fingerprints, file moves, restoration, and every post-restore assertion that reads the shared paths.

**Why:** Releasing after restoration but before verification lets the next run move the files while the prior run is still checking them. Age-only stale cleanup can also evict a legitimate long-running owner or remove a replacement lock during a race.

**How to apply:** Keep ownership through the outermost verification cleanup. Serialize lock-state transitions, identify the exact owner process, and reclaim only an expired lock whose recorded owner is no longer alive.

Lock identity must use canonical filesystem identities, resolving existing outputs directly and missing outputs through their nearest existing ancestor while preserving the unresolved suffix.

**Why:** Configured path strings can differ while reaching the same generated files through symlinks or junctions, allowing two runs to acquire different locks and overlap file moves.

**How to apply:** Canonicalize and deduplicate the full generated-path set before hashing it. Keep configured paths for actual file operations and accept legacy manifest keys when recovering transactions created before canonical locking.

Portable owner checks should compare process start-time identity where the host exposes it, but treat a live PID as active when identity metadata is temporarily unavailable. A live PID with a different recorded identity is a reused-owner blocker for stale lock takeover and transaction recovery, not an abandoned lock or transaction.

**Why:** Non-Linux workers do not expose Linux proc metadata, while failing open on a missing platform command can reclaim a genuinely live owner. A replacement process can still be using the same generated paths, so recovery must not mutate the old transaction until the replacement is inspected.

**How to apply:** Use native start-time probes on supported hosts, keep metadata-unavailable live-PID fallback conservative, and reject stale lock takeover or the recovery batch when a live PID's identity differs from the recorded owner identity. Keep lock stale reclamation separate from transaction recovery.

Backup transactions must publish a complete manifest atomically before moving outputs, record whether validation started, and track the validation process group separately from the harness owner.

**Why:** A forced harness termination can leave both partially regenerated output and an orphaned compiler; file presence alone cannot distinguish that output from a newer valid build.

**How to apply:** Clean unpublished staging directories, stop the exact recorded validation group before recovery, and verify conflicting regenerated output before preserving it instead of restoring the backup.

Recovery manifests must identify their own generated-path set with validated workspace-relative paths rather than relying on the next run's current configuration.

**Why:** Build references and output directories can change between an interrupted run and recovery; matching against the new path set can permanently strand a safe backup.

**How to apply:** Resolve recorded paths inside the workspace, reject duplicates and lock-key mismatches, refuse live owners, and retain strict handling for legacy manifests that lack portable path identity.

Validate every source and backup destination for every abandoned transaction before stopping any recorded validation process or deleting staging state.

**Why:** A malformed destination discovered during per-transaction recovery can otherwise stop an unrelated compiler process before recovery learns that the transaction is unsafe to touch.

**How to apply:** Complete a read-only preflight of the full recovery batch first, make each error identify its transaction, and regression-test that sources, backups, transaction directories, and recorded processes remain unchanged on rejection.

Each generated source may be claimed by only one transaction in a recovery batch; reject the whole batch and identify every claimant before cleanup or recovery begins.

**Why:** Individually valid abandoned manifests can overlap, causing a later recovery to act on output already changed by an earlier one.

**How to apply:** After all manifests pass per-transaction validation, canonicalize each source through its nearest existing ancestor, group claims by canonical identity, and reject every duplicate before stopping validation processes or modifying any filesystem state. Preserve unresolved suffixes so missing generated outputs remain recoverable.

The generated-output lock must be acquired once per canonical path, in sorted order, rather than once for the complete configured set. A short separate transition lock must protect the global transaction-directory scan and active-manifest publication.

**Why:** Different checks can have partially overlapping generated-output sets. A whole-set lock lets those checks mutate a shared path concurrently, while an uncoordinated global recovery scan can delete another check's newly-created staging directory.

**How to apply:** Keep per-path ownership through fingerprints, moves, validation, restoration, and post-restore checks. Serialize only recovery/staging metadata operations globally so disjoint generated-output sets still run concurrently, and ignore live transactions whose canonical paths are disjoint from the paths currently owned.

Recovery of abandoned paths outside the active configuration must discover manifest identities under the transition lock, release that lock before acquiring the discovered output locks, then reacquire and rediscover until the path set is stable.

**Why:** Acquiring a dropped path while holding the transition lock deadlocks against a check that owns that path and is waiting to publish metadata; a single discovery pass can also miss a transaction published during the handoff.

**How to apply:** Skip live transactions on disjoint paths during discovery and preflight, but keep their output locks out of the recovery wait; hold every discovered abandoned-path lock through fingerprints, restoration, and cleanup.