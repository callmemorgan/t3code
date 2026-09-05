import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  parseServiceState,
  SERVICE_STATE_FILE,
  type ServiceState,
} from "./serviceProtocol.ts";

/**
 * A pinned runtime is an exact `t3@<version>` npm-installed into
 * <baseDir>/runtime/versions/<version>. The boot service points its unit or
 * launch agent here, and server self-update installs the target version here before
 * switching over, never `npx t3`, whose cache is ephemeral and whose
 * registry fetch at boot would make startup depend on the network.
 */

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_LOCK_FILE = "versions.lock";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
// Boot-service setup and remote update can construct separate layers. Serialize
// the complete install transaction across every caller in this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export interface PinnedRuntimePruneResult {
  readonly dryRun: boolean;
  readonly versions: ReadonlyArray<string>;
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
): PinnedRuntimePaths {
  const versionDir = path.join(baseDir, PINNED_RUNTIME_DIR, "versions", version);
  return {
    versionDir,
    entryPath: path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedErrorClass<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedErrorClass<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Installs `t3@<version>` into the pinned runtime directory unless a complete
 * install is already there, and returns its paths. The sentinel is written
 * only after npm exits 0; checking the entry file alone is not enough. npm
 * extracts files before running native builds (node-pty), so a killed
 * install leaves a plausible-looking but broken tree behind.
 */
interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
}

const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const { fs, runner } = input;
  const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version);
  const [versionDirExists, entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.versionDir),
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(
    Effect.mapError(
      (cause) => new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
    ),
  );
  const alreadyPinned =
    entryExists && Option.isSome(sentinel) && sentinel.value.trim() === input.version;
  if (alreadyPinned) {
    yield* input.validate(paths);
    return paths;
  }
  if (versionDirExists) {
    yield* fs.remove(paths.versionDir, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "removing an incomplete pinned runtime",
            cause,
          }),
      ),
    );
  }

  const versionsDir = input.path.dirname(paths.versionDir);
  yield* fs.makeDirectory(versionsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: "preparing the pinned runtime directory",
          cause,
        }),
    ),
  );
  const stagingDir = yield* fs
    .makeTempDirectory({
      directory: versionsDir,
      prefix: ".staging-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "preparing the pinned runtime directory",
            cause,
          }),
      ),
    );
  const stagingPaths: PinnedRuntimePaths = {
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, "node_modules", "t3", "dist", "bin.mjs"),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };

  return yield* Effect.gen(function* () {
    const installStep = "installing the pinned t3 runtime (this can take a few minutes)";
    yield* runner
      .run({
        command: "npm",
        args: ["install", "--prefix", stagingDir, "--no-fund", "--no-audit", `t3@${input.version}`],
        // Native dependencies may compile from source on slower machines.
        timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
      })
      .pipe(
        Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: installStep, cause })),
        Effect.filterOrFail(
          (result) => result.code === 0,
          (result) =>
            new PinnedRuntimeInstallError({
              step: installStep,
              exitCode: Number(result.code),
              stdoutLength: result.stdout.length,
              stderrLength: result.stderr.length,
            }),
        ),
      );

    yield* input.validate(stagingPaths);
    yield* fs
      .writeFileString(stagingPaths.sentinelPath, `${input.version}\n`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording the completed install", cause }),
        ),
      );
    const published = yield* fs.rename(stagingDir, paths.versionDir).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.all([
          fs.exists(paths.entryPath),
          fs.readFileString(paths.sentinelPath).pipe(Effect.option),
        ]).pipe(
          Effect.mapError(
            (checkCause) =>
              new PinnedRuntimeInstallError({
                step: "checking a concurrently published pinned runtime",
                cause: checkCause,
              }),
          ),
          Effect.flatMap(([publishedEntryExists, publishedSentinel]) =>
            publishedEntryExists &&
            Option.isSome(publishedSentinel) &&
            publishedSentinel.value.trim() === input.version
              ? Effect.succeed(false)
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "publishing the pinned runtime",
                    cause,
                  }),
                ),
          ),
        ),
      ),
    );
    if (!published) yield* input.validate(paths);
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensurePinnedRuntimeInstalled = (input: PinnedRuntimeInstallInput) =>
  pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input));

export class PinnedRuntimeBusyError extends Schema.TaggedErrorClass<PinnedRuntimeBusyError>()(
  "PinnedRuntimeBusyError",
  { lockPath: Schema.String, pid: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return this.pid === undefined
      ? `Another process holds the service runtime lock at '${this.lockPath}'.`
      : `Process ${this.pid} holds the service runtime lock at '${this.lockPath}'.`;
  }
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Serializes the processes that change runtime/versions: the CLI's install,
 * which is the only path that can move the active version backward, and both
 * prune callers. Pruning decides from one read of launcher state, so a
 * downgrade that selected an older runtime between that read and the delete
 * would leave the service pointing at a missing runtime. Forward updates never
 * conflict, because they only add versions newer than the active one and
 * pruning never touches those, so the launcher's remote update stays
 * lock-free.
 *
 * The lock is a file created exclusively that holds its owner's pid. A lock
 * whose owner is gone is stale and taken over by renaming it aside first, so
 * two contenders that both saw the dead owner race on the rename and the loser
 * retries against the winner's fresh lock instead of deleting it. The window
 * that remains needs a third process to take the lock between one contender's
 * pid check and its rename. A lock whose owner is alive fails fast with
 * PinnedRuntimeBusyError instead of waiting; the lock is not reentrant.
 */
export const withPinnedRuntimeLock = <A, E, R>(
  input: {
    readonly baseDir: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly pid?: number;
    readonly isProcessAlive?: (pid: number) => boolean;
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PinnedRuntimeBusyError | PlatformError.PlatformError, R> => {
  const lockPath = input.path.join(input.baseDir, PINNED_RUNTIME_DIR, PINNED_RUNTIME_LOCK_FILE);
  const pid = input.pid ?? process.pid;
  const isProcessAlive = input.isProcessAlive ?? processIsAlive;
  const create = Effect.scoped(
    Effect.gen(function* () {
      const file = yield* input.fs.open(lockPath, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(new TextEncoder().encode(`${pid}\n`));
    }),
  );
  const claim = (
    takeovers: number,
  ): Effect.Effect<void, PinnedRuntimeBusyError | PlatformError.PlatformError> =>
    create.pipe(
      Effect.catch((error) =>
        error.reason._tag !== "AlreadyExists"
          ? Effect.fail(error)
          : Effect.gen(function* () {
              // The holder may release between our failed create and this read.
              const contents = yield* input.fs
                .readFileString(lockPath)
                .pipe(
                  Effect.catch((readError) =>
                    readError.reason._tag === "NotFound"
                      ? Effect.succeed("")
                      : Effect.fail(readError),
                  ),
                );
              const holder = Number.parseInt(contents.trim(), 10);
              const holderPid = Number.isInteger(holder) && holder > 0 ? holder : undefined;
              if ((holderPid !== undefined && isProcessAlive(holderPid)) || takeovers === 0) {
                return yield* new PinnedRuntimeBusyError({ lockPath, pid: holderPid });
              }
              const stalePath = `${lockPath}.stale-${pid}`;
              yield* input.fs
                .rename(lockPath, stalePath)
                .pipe(
                  Effect.catch((renameError) =>
                    renameError.reason._tag === "NotFound" ? Effect.void : Effect.fail(renameError),
                  ),
                );
              yield* input.fs.remove(stalePath, { force: true });
              return yield* claim(takeovers - 1);
            }),
      ),
    );
  return Effect.scoped(
    Effect.gen(function* () {
      yield* input.fs.makeDirectory(input.path.dirname(lockPath), { recursive: true });
      yield* Effect.acquireRelease(claim(2), () =>
        input.fs.remove(lockPath, { force: true }).pipe(Effect.ignore),
      );
      return yield* effect;
    }),
  );
};

/**
 * Removes runtimes older than the active one, keeping the newest `keep`
 * complete ones beside the active version. Never touches the active version,
 * either version named by the latest update record, anything newer than the
 * active version (a concurrently staged forward-update target), staging
 * directories, symlinks, or unexpected directory names. Every published
 * runtime carries its sentinel from the staging step, so an older version
 * directory without a matching one is a leftover (a pre-staging install or an
 * interrupted removal): it is removed but never counts toward `keep`.
 */
export const prunePinnedRuntimes = Effect.fn("cloud.pinned_runtime.prune")(function* (input: {
  readonly baseDir: string;
  readonly state: ServiceState;
  readonly keep: number;
  readonly dryRun: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const versionsDir = input.path.join(input.baseDir, PINNED_RUNTIME_DIR, "versions");
  if (!(yield* input.fs.exists(versionsDir))) {
    return { dryRun: input.dryRun, versions: [] } satisfies PinnedRuntimePruneResult;
  }

  const protectedVersions = new Set([
    input.state.activeVersion,
    ...(input.state.update === undefined
      ? []
      : [input.state.update.fromVersion, input.state.update.targetVersion]),
  ]);
  const realVersionsDir = yield* input.fs.realPath(versionsDir);
  const entries = yield* input.fs.readDirectory(versionsDir);
  const older: Array<{ readonly version: string; readonly complete: boolean }> = [];
  for (const version of entries) {
    if (
      !isExactServiceVersion(version) ||
      compareExactServiceVersions(version, input.state.activeVersion) >= 0
    ) {
      continue;
    }
    const paths = pinnedRuntimePaths(input.path, input.baseDir, version);
    const realVersionDir = yield* input.fs.realPath(paths.versionDir).pipe(Effect.option);
    if (
      Option.isNone(realVersionDir) ||
      realVersionDir.value !== input.path.join(realVersionsDir, version)
    ) {
      continue;
    }
    const [entryExists, sentinel] = yield* Effect.all([
      input.fs.exists(paths.entryPath),
      input.fs.readFileString(paths.sentinelPath).pipe(Effect.option),
    ]);
    older.push({
      version,
      complete: entryExists && Option.isSome(sentinel) && sentinel.value.trim() === version,
    });
  }
  older.sort((left, right) => {
    const precedence = compareExactServiceVersions(left.version, right.version);
    return precedence === 0 ? left.version.localeCompare(right.version) : precedence;
  });
  // The newest complete previous runtimes count toward `keep` whether or not
  // the update record already protects them, so "keep 2" reads as two usable
  // versions. Leftovers are never usable and never counted.
  const complete = older.filter((entry) => entry.complete).map((entry) => entry.version);
  const retained = new Set(complete.slice(Math.max(0, complete.length - input.keep)));
  const versions = older
    .map((entry) => entry.version)
    .filter((version) => !protectedVersions.has(version) && !retained.has(version));

  if (!input.dryRun) {
    yield* Effect.forEach(
      versions,
      (version) => {
        const paths = pinnedRuntimePaths(input.path, input.baseDir, version);
        // Drop the sentinel first so an interrupted removal never leaves a tree
        // that still claims to be a complete install.
        return input.fs
          .remove(paths.sentinelPath, { force: true })
          .pipe(
            Effect.andThen(input.fs.remove(paths.versionDir, { recursive: true, force: true })),
          );
      },
      { discard: true },
    );
  }

  return { dryRun: input.dryRun, versions } satisfies PinnedRuntimePruneResult;
});

export type PinnedRuntimeSweepResult =
  | ({ readonly status: "pruned" } & PinnedRuntimePruneResult)
  | {
      readonly status: "skipped";
      readonly reason: "no-service-state" | "invalid-service-state" | "update-pending";
    };

/**
 * Applies the retention count against launcher-owned state. The launcher is
 * the only writer of that state, so a missing or invalid file and a pending
 * update all skip the sweep instead of guessing which runtimes are still
 * needed; callers decide whether a skip is an error or a log line. A file that
 * exists but cannot be read is a different situation and fails with the
 * filesystem cause, so a permissions or I/O problem is never reported as
 * "no state".
 */
export const sweepPinnedRuntimes = Effect.fn("cloud.pinned_runtime.sweep")(function* (input: {
  readonly baseDir: string;
  readonly keep: number;
  readonly dryRun: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const statePath = input.path.join(input.baseDir, PINNED_RUNTIME_DIR, SERVICE_STATE_FILE);
  const stateText = yield* input.fs.readFileString(statePath).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(Option.none<string>()) : Effect.fail(error),
    ),
  );
  if (Option.isNone(stateText)) {
    return { status: "skipped", reason: "no-service-state" } as const;
  }
  const state = parseServiceState(stateText.value);
  if (state === undefined) {
    return { status: "skipped", reason: "invalid-service-state" } as const;
  }
  if (state.update?.status === "pending") {
    return { status: "skipped", reason: "update-pending" } as const;
  }
  const result = yield* prunePinnedRuntimes({ ...input, state });
  return { status: "pruned", ...result } satisfies PinnedRuntimeSweepResult;
});

/**
 * The startup side of retention. Only a launcher-managed server owns
 * runtime/versions, so a foreground `npx t3` process never walks it. Nothing
 * here can fail the caller: a permissions problem or a slow delete is a
 * warning, not a boot failure. A skip is also a warning rather than debug
 * noise, because on a managed server whose update has settled, missing,
 * invalid, or still-pending state is an anomaly an operator asking "did
 * cleanup run?" needs to see.
 */
export const sweepManagedRuntimes = <E>(input: {
  readonly managed: boolean;
  readonly baseDir: string;
  readonly retainedRuntimes: Effect.Effect<number, E>;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!input.managed) return;
    const keep = yield* input.retainedRuntimes;
    const result = yield* withPinnedRuntimeLock(
      input,
      sweepPinnedRuntimes({
        baseDir: input.baseDir,
        keep,
        dryRun: false,
        fs: input.fs,
        path: input.path,
      }),
    );
    if (result.status === "skipped") {
      yield* Effect.logWarning("Skipped the service runtime sweep", { reason: result.reason });
    } else if (result.versions.length > 0) {
      yield* Effect.logInfo("Removed old service runtimes", { keep, versions: result.versions });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not remove old service runtimes", { cause }),
    ),
    Effect.withSpan("cloud.pinned_runtime.startup_sweep"),
  );
