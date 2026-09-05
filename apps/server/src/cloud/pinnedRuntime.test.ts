import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeBusyError,
  PinnedRuntimeInstallError,
  prunePinnedRuntimes,
  sweepManagedRuntimes,
  sweepPinnedRuntimes,
  withPinnedRuntimeLock,
} from "./pinnedRuntime.ts";
import { SERVICE_LAUNCHER_PROTOCOL, type ServiceState } from "./serviceProtocol.ts";

const successfulRunner = (fs: FileSystem.FileSystem, path: Path.Path) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const prefixIndex = input.args.indexOf("--prefix");
        const stagingDir = input.args[prefixIndex + 1];
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
        const entry = path.join(stagingDir, "node_modules", "t3", "dist", "bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

const writeCompletedRuntime = Effect.fn("test.write_completed_runtime")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  baseDir: string,
  version: string,
) {
  const runtime = pinnedRuntimePaths(path, baseDir, version);
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "export {};\n");
  yield* fs.writeFileString(runtime.sentinelPath, `${version}\n`);
  return runtime;
});

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), "1.2.3\n");
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("replaces an incomplete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: () => Effect.void,
      });

      assert.isFalse(yield* fs.exists(path.join(finalPaths.versionDir, "partial")));
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, "1.2.3\n");

      let validations = 0;
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );

  it.effect("removes staging when installation is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-interrupt-" });
      const started = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner,
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      const versionsDir = path.join(baseDir, "runtime", "versions");
      assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
    }),
  );
});

it.layer(NodeServices.layer)("prunePinnedRuntimes", (it) => {
  it.effect(
    "removes unreferenced older runtimes and leftovers, never anything newer, linked, or protected",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-prune-" });
        const removable = yield* writeCompletedRuntime(fs, path, baseDir, "1.8.0");
        const rollback = yield* writeCompletedRuntime(fs, path, baseDir, "1.9.0");
        const active = yield* writeCompletedRuntime(fs, path, baseDir, "2.0.0");
        const newer = yield* writeCompletedRuntime(fs, path, baseDir, "2.1.0");
        const incomplete = pinnedRuntimePaths(path, baseDir, "1.7.0");
        yield* fs.makeDirectory(incomplete.versionDir, { recursive: true });
        const wrongSentinel = yield* writeCompletedRuntime(fs, path, baseDir, "1.6.0");
        yield* fs.writeFileString(wrongSentinel.sentinelPath, "wrong-version\n");
        const staging = path.join(path.dirname(active.versionDir), ".staging-install");
        yield* fs.makeDirectory(staging);
        const linkedTarget = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-runtime-link-target-",
        });
        const linkedRuntime = pinnedRuntimePaths(path, baseDir, "1.5.0");
        yield* fs.symlink(linkedTarget, linkedRuntime.versionDir);

        const state = {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "2.0.0",
          update: {
            id: "committed-update",
            fromVersion: "1.9.0",
            targetVersion: "2.0.0",
            status: "committed",
          },
        } satisfies ServiceState;

        // keep: 1 retains 1.9.0, the newest complete previous runtime. The two
        // leftovers (no sentinel, wrong sentinel) go regardless and do not use
        // up the retention slot.
        const prune = (dryRun: boolean) =>
          prunePinnedRuntimes({ baseDir, state, keep: 1, dryRun, fs, path });
        const preview = yield* prune(true);
        assert.deepEqual(preview, { dryRun: true, versions: ["1.6.0", "1.7.0", "1.8.0"] });
        assert.isTrue(yield* fs.exists(removable.versionDir));

        const pruned = yield* prune(false);
        assert.deepEqual(pruned, { dryRun: false, versions: ["1.6.0", "1.7.0", "1.8.0"] });
        for (const removed of [
          removable.versionDir,
          incomplete.versionDir,
          wrongSentinel.versionDir,
        ]) {
          assert.isFalse(yield* fs.exists(removed));
        }
        for (const preserved of [
          rollback.versionDir,
          active.versionDir,
          newer.versionDir,
          staging,
          linkedRuntime.versionDir,
        ]) {
          assert.isTrue(yield* fs.exists(preserved));
        }
      }),
  );

  it.effect("keeps the newest previous runtimes up to the retention count", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-keep-" });
      for (const version of ["1.6.0", "1.7.0", "1.8.0", "1.9.0", "2.0.0"]) {
        yield* writeCompletedRuntime(fs, path, baseDir, version);
      }
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "2.0.0",
        update: {
          id: "committed-update",
          fromVersion: "1.9.0",
          targetVersion: "2.0.0",
          status: "committed",
        },
      } satisfies ServiceState;
      const preview = (keep: number) =>
        prunePinnedRuntimes({ baseDir, state, keep, dryRun: true, fs, path });

      assert.deepEqual((yield* preview(2)).versions, ["1.6.0", "1.7.0"]);
      assert.deepEqual((yield* preview(3)).versions, ["1.6.0"]);
      assert.deepEqual((yield* preview(10)).versions, []);
    }),
  );

  it.effect("sweeps from launcher state and skips when the launcher is mid-update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-sweep-" });
      const stale = yield* writeCompletedRuntime(fs, path, baseDir, "1.8.0");
      yield* writeCompletedRuntime(fs, path, baseDir, "1.9.0");
      yield* writeCompletedRuntime(fs, path, baseDir, "2.0.0");
      const statePath = path.join(baseDir, "runtime", "service-state.json");
      const sweep = sweepPinnedRuntimes({ baseDir, keep: 1, dryRun: false, fs, path });

      assert.deepEqual(yield* sweep, { status: "skipped", reason: "no-service-state" });
      yield* fs.writeFileString(statePath, "not json");
      assert.deepEqual(yield* sweep, { status: "skipped", reason: "invalid-service-state" });
      yield* fs.writeFileString(
        statePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
        JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.9.0",
          update: {
            id: "trial",
            fromVersion: "1.9.0",
            targetVersion: "2.0.0",
            dbPath: "/tmp/state.sqlite",
            status: "pending",
          },
        }),
      );
      assert.deepEqual(yield* sweep, { status: "skipped", reason: "update-pending" });
      assert.isTrue(yield* fs.exists(stale.versionDir));

      yield* fs.writeFileString(
        statePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
        JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "2.0.0",
          update: {
            id: "trial",
            fromVersion: "1.9.0",
            targetVersion: "2.0.0",
            status: "committed",
          },
        }),
      );
      assert.deepEqual(yield* sweep, { status: "pruned", dryRun: false, versions: ["1.8.0"] });
      assert.isFalse(yield* fs.exists(stale.versionDir));
    }),
  );

  it.effect("fails instead of reporting missing state when the state file cannot be read", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        description: "permission denied",
        pathOrDescriptor: "/t3/runtime/service-state.json",
      });
      const fs = FileSystem.makeNoop({ readFileString: () => Effect.fail(cause) });

      const error = yield* sweepPinnedRuntimes({
        baseDir: "/t3",
        keep: 1,
        dryRun: false,
        fs,
        path,
      }).pipe(Effect.flip);

      assert.strictEqual(error, cause);
    }),
  );
});

it.layer(NodeServices.layer)("sweepManagedRuntimes", (it) => {
  const committedState = (activeVersion: string, fromVersion: string) =>
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
    JSON.stringify({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion,
      update: { id: "update", fromVersion, targetVersion: activeVersion, status: "committed" },
    });

  it.effect("never touches the runtime directory for a server the launcher does not manage", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const reads: string[] = [];
      const fs = FileSystem.makeNoop({
        readFileString: (file) => {
          reads.push(file);
          return Effect.succeed(committedState("2.0.0", "1.9.0"));
        },
      });

      yield* sweepManagedRuntimes({
        managed: false,
        baseDir: "/t3",
        retainedRuntimes: Effect.succeed(1),
        fs,
        path,
      });

      assert.deepEqual(reads, []);
    }),
  );

  it.effect("prunes a managed server to the retention count", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-sweep-" });
      const stale = yield* writeCompletedRuntime(fs, path, baseDir, "1.8.0");
      const previous = yield* writeCompletedRuntime(fs, path, baseDir, "1.9.0");
      const active = yield* writeCompletedRuntime(fs, path, baseDir, "2.0.0");
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "service-state.json"),
        committedState("2.0.0", "1.9.0"),
      );

      yield* sweepManagedRuntimes({
        managed: true,
        baseDir,
        retainedRuntimes: Effect.succeed(1),
        fs,
        path,
      });

      assert.isFalse(yield* fs.exists(stale.versionDir));
      assert.isTrue(yield* fs.exists(previous.versionDir));
      assert.isTrue(yield* fs.exists(active.versionDir));
    }),
  );

  it.effect("succeeds without deleting anything when the sweep cannot run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-sweep-fail-" });
      const stale = yield* writeCompletedRuntime(fs, path, baseDir, "1.8.0");
      yield* writeCompletedRuntime(fs, path, baseDir, "2.0.0");
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "service-state.json"),
        committedState("2.0.0", "1.9.0"),
      );

      // The settings lookup fails: the sweep must swallow it, not fail startup.
      yield* sweepManagedRuntimes({
        managed: true,
        baseDir,
        retainedRuntimes: Effect.fail("settings unavailable"),
        fs,
        path,
      });
      assert.isTrue(yield* fs.exists(stale.versionDir));

      // Another live process holds the runtime lock: same contract.
      yield* fs.writeFileString(path.join(baseDir, "runtime", "versions.lock"), `${process.pid}\n`);
      yield* sweepManagedRuntimes({
        managed: true,
        baseDir,
        retainedRuntimes: Effect.succeed(0),
        fs,
        path,
      });
      assert.isTrue(yield* fs.exists(stale.versionDir));
      yield* fs.remove(path.join(baseDir, "runtime", "versions.lock"));

      // The state file cannot be read: same contract.
      const unreadable = FileSystem.makeNoop({
        readFileString: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path.join(baseDir, "runtime", "service-state.json"),
            }),
          ),
      });
      yield* sweepManagedRuntimes({
        managed: true,
        baseDir,
        retainedRuntimes: Effect.succeed(1),
        fs: unreadable,
        path,
      });
      assert.isTrue(yield* fs.exists(stale.versionDir));
    }),
  );
});

it.layer(NodeServices.layer)("withPinnedRuntimeLock", (it) => {
  it.effect("refuses a second holder while the first is alive, then releases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-lock-" });
      const lockPath = path.join(baseDir, "runtime", "versions.lock");
      let innerRan = false;

      const contended = yield* withPinnedRuntimeLock(
        { baseDir, fs, path, pid: 100, isProcessAlive: () => true },
        Effect.gen(function* () {
          assert.strictEqual((yield* fs.readFileString(lockPath)).trim(), "100");
          return yield* withPinnedRuntimeLock(
            { baseDir, fs, path, pid: 200, isProcessAlive: () => true },
            Effect.sync(() => {
              innerRan = true;
            }),
          ).pipe(Effect.flip);
        }),
      );

      assert.instanceOf(contended, PinnedRuntimeBusyError);
      assert.strictEqual(contended.pid, 100);
      assert.strictEqual(contended.lockPath, lockPath);
      assert.isFalse(innerRan);
      assert.isFalse(yield* fs.exists(lockPath));
    }),
  );

  it.effect("takes over a lock whose owner is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-lock-stale-" });
      const lockPath = path.join(baseDir, "runtime", "versions.lock");
      yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
      yield* fs.writeFileString(lockPath, "4242\n");

      const owner = yield* withPinnedRuntimeLock(
        { baseDir, fs, path, pid: 7, isProcessAlive: (pid) => pid !== 4242 },
        fs.readFileString(lockPath),
      );

      assert.strictEqual(owner.trim(), "7");
      assert.isFalse(yield* fs.exists(lockPath));
    }),
  );

  it.effect("releases the lock when the guarded effect fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-lock-fail-" });

      const failure = yield* withPinnedRuntimeLock(
        { baseDir, fs, path },
        Effect.fail("boom" as const),
      ).pipe(Effect.flip);

      assert.strictEqual(failure, "boom");
      assert.isFalse(yield* fs.exists(path.join(baseDir, "runtime", "versions.lock")));
    }),
  );
});
