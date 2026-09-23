import type { PlatformError } from "effect"
import { Clock, Context, Data, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect"
import { AppError, Errors } from "../errors.ts"
import { Task } from "../domain/task.ts"

const StoreFile = Schema.Struct({
  tasks: Schema.Array(Task),
})

const StoreFileJson = Schema.fromJsonString(StoreFile)
// Strict: a field this version does not know would be dropped by the next write.
const decodeStore = Schema.decodeEffect(StoreFileJson, { onExcessProperty: "error" })
const encodeStore = Schema.encodeEffect(StoreFileJson)

export interface StoreReaderApi {
  readonly load: Effect.Effect<ReadonlyArray<Task>, AppError>
}

export interface StoreWriterApi {
  /** Atomic read-transform-write under a lock. Return null to leave the file untouched. */
  readonly modify: (
    transform: (tasks: ReadonlyArray<Task>) => ReadonlyArray<Task> | null,
  ) => Effect.Effect<ReadonlyArray<Task>, AppError>
}

const DIR = ".lasso"
const FILE = "tasks.json"
const LOCK = "tasks.lock"
const STALE_LOCK_MILLIS = 30_000

const WRITE_FIX = `check write permissions on ${DIR}/ in the current directory, or run from a writable directory`

const asCannotWrite = (what: string) => (cause: PlatformError.PlatformError) =>
  Errors.cannotWrite({ message: `cannot ${what}: ${cause.message}`, fix: WRITE_FIX })

// A store that cannot be read is a misconfigured environment, not a failed write.
const asUnreadable = (what: string) => (cause: PlatformError.PlatformError) =>
  Errors.invalidConfig({
    message: `cannot ${what}: ${cause.message}`,
    fix:
      cause.reason._tag === "PermissionDenied"
        ? `grant read permission on ${DIR}/${FILE}, or run from the directory that owns the store`
        : `${DIR} must be a directory holding ${FILE}: move aside whatever is at ${DIR}`,
  })

/** Another writer holds the lock: retried, never surfaced as-is. */
class LockBusy extends Data.TaggedError("LockBusy") {}

const loadFrom = Effect.fn("store.load")(function* (fs: FileSystem.FileSystem, file: string) {
  const exists = yield* fs.exists(file).pipe(Effect.mapError(asUnreadable(`access ${file}`)))
  if (!exists) {
    return []
  }
  const raw = yield* fs.readFileString(file).pipe(Effect.mapError(asUnreadable(`read ${file}`)))
  const decoded = yield* decodeStore(raw).pipe(
    Effect.mapError((cause) =>
      Errors.invalidConfig({
        message: `${file} is not a valid task store: ${cause.message}`,
        fix: `inspect ${file} and repair or delete it`,
      }),
    ),
  )
  return decoded.tasks
})

export class StoreReader extends Context.Service<StoreReader, StoreReaderApi>()(
  "lasso/services/StoreReader",
) {
  static readonly layer: Layer.Layer<StoreReader, never, FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      StoreReader,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        return StoreReader.of({ load: loadFrom(fs, path.join(DIR, FILE)) })
      }),
    )
}

export class StoreWriter extends Context.Service<StoreWriter, StoreWriterApi>()(
  "lasso/services/StoreWriter",
) {
  static readonly layer: Layer.Layer<StoreWriter, never, FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      StoreWriter,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const file = path.join(DIR, FILE)
        const lock = path.join(DIR, LOCK)
        // One name is enough: the lock admits one writer at a time, and a temp
        // file a killed writer left behind is overwritten by the next write.
        const tmp = `${file}.tmp`

        // A live holder keeps the lock for milliseconds. One this old was left by
        // a killed process: retrying cannot help, so it is not transient.
        const lockHeld = Effect.gen(function* () {
          const info = yield* fs.stat(lock).pipe(Effect.option)
          const now = yield* Clock.currentTimeMillis
          const mtime = info._tag === "Some" ? info.value.mtime : undefined
          const age = mtime?._tag === "Some" ? now - mtime.value.getTime() : 0
          return yield* age > STALE_LOCK_MILLIS
            ? Errors.cannotWrite({
                message: `the task store lock ${lock} is ${Math.round(age / 1000)}s old; its process exited without releasing it`,
                fix: `confirm no other ${DIR} writer is running, then remove the lock: rm -r ${lock}`,
              })
            : Errors.transientFailure({
                message: "the task store is locked by another process",
                fix: "retry the command",
              })
        })

        // Exclusive directory creation serializes concurrent writers. One attempt
        // only: acquire runs uninterruptibly, so waiting for the lock belongs
        // outside it (see modify).
        const acquireLock = Effect.gen(function* () {
          yield* fs
            .makeDirectory(DIR, { recursive: true })
            .pipe(Effect.mapError(asCannotWrite(`create ${DIR}`)))
          yield* fs.makeDirectory(lock).pipe(
            Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.fail(new LockBusy())),
            Effect.mapError((error) =>
              error._tag === "LockBusy"
                ? error
                : Errors.cannotWrite({
                    message: `cannot create ${lock}: ${error.message}`,
                    fix: WRITE_FIX,
                  }),
            ),
          )
        })

        const releaseLock = fs.remove(lock, { recursive: true }).pipe(Effect.ignore)

        const modify: StoreWriterApi["modify"] = Effect.fn("StoreWriter.modify")(
          function* (transform) {
            return yield* Effect.acquireUseRelease(
              acquireLock,
              Effect.fn("StoreWriter.modify.use")(function* () {
                const current = yield* loadFrom(fs, file)
                const next = transform(current)
                if (next === null) {
                  return current
                }
                const encoded = yield* encodeStore({ tasks: next }).pipe(
                  Effect.mapError((cause) =>
                    Errors.invalidData({
                      message: `tasks failed to encode: ${cause.message}`,
                      fix: "this is a bug in the Task schema or the transform; report the command you ran",
                    }),
                  ),
                )
                yield* fs.writeFileString(tmp, `${encoded}\n`).pipe(
                  Effect.mapError(asCannotWrite(`write ${tmp}`)),
                  Effect.andThen(
                    fs.rename(tmp, file).pipe(Effect.mapError(asCannotWrite(`replace ${file}`))),
                  ),
                  // A failed or interrupted write leaves no temp file behind.
                  Effect.onError(() => fs.remove(tmp).pipe(Effect.ignore)),
                )
                return next
              }),
              () => releaseLock,
            ).pipe(
              // Retry contention only, between attempts, where Ctrl-C and SIGTERM
              // can still interrupt a writer queued behind another one.
              Effect.retry({
                // Jitter spreads writers that collided so they do not collide again.
                schedule: Schedule.spaced("25 millis").pipe(Schedule.jittered),
                times: 40,
                while: (error) => error._tag === "LockBusy",
              }),
              Effect.catchTag("LockBusy", () => lockHeld),
            )
          },
        )

        return StoreWriter.of({ modify })
      }),
    )
}
