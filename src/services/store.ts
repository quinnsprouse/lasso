import { Clock, Context, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect"
import { AppError, Errors } from "../errors.ts"
import { Task } from "../domain/task.ts"

const StoreFile = Schema.Struct({
  tasks: Schema.Array(Task),
})

const StoreFileJson = Schema.fromJsonString(StoreFile)
const decodeStore = Schema.decodeEffect(StoreFileJson)
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

const WRITE_FIX = `check write permissions on ${DIR}/ in the current directory, or run from a writable directory`
const READ_FIX = `check read permissions on ${DIR}/${FILE}, or run from the directory that owns the store`

const asCannotWrite = (what: string) => (cause: { message: string }) =>
  Errors.cannotWrite({ message: `cannot ${what}: ${cause.message}`, fix: WRITE_FIX })

// Uniquifies temp files within one process; the lock serializes across processes.
let tmpCounter = 0

const loadFrom = Effect.fn("store.load")(function* (fs: FileSystem.FileSystem, file: string) {
  const exists = yield* fs
    .exists(file)
    .pipe(
      Effect.mapError((cause) =>
        Errors.cannotWrite({ message: `cannot access ${file}: ${cause.message}`, fix: READ_FIX }),
      ),
    )
  if (!exists) {
    return []
  }
  const raw = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError((cause) =>
        Errors.cannotWrite({ message: `cannot read ${file}: ${cause.message}`, fix: READ_FIX }),
      ),
    )
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

        // Exclusive directory creation serializes concurrent writers.
        const acquireLock = Effect.gen(function* () {
          yield* fs
            .makeDirectory(DIR, { recursive: true })
            .pipe(Effect.mapError(asCannotWrite(`create ${DIR}`)))
          // Retry contention only; permission failures should fail immediately.
          yield* fs.makeDirectory(lock).pipe(
            Effect.retry({
              schedule: Schedule.spaced("25 millis"),
              times: 40,
              while: (error) => error.reason._tag === "AlreadyExists",
            }),
            Effect.mapError((error) =>
              error.reason._tag === "AlreadyExists"
                ? Errors.transientFailure({
                    message: "the task store is locked by another process",
                    fix: `retry; if it persists, remove the stale ${lock} directory`,
                  })
                : Errors.cannotWrite({
                    message: `cannot create ${lock}: ${error.message}`,
                    fix: WRITE_FIX,
                  }),
            ),
          )
        })

        const releaseLock = fs.remove(lock, { recursive: true }).pipe(Effect.ignore)

        const modify: StoreWriterApi["modify"] = (transform) =>
          Effect.acquireUseRelease(
            acquireLock,
            Effect.fn("store.modify")(function* () {
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
              const stamp = yield* Clock.currentTimeMillis
              tmpCounter += 1
              const tmp = `${file}.${stamp.toString(36)}.${tmpCounter}.tmp`
              yield* fs
                .writeFileString(tmp, `${encoded}\n`)
                .pipe(Effect.mapError(asCannotWrite(`write ${tmp}`)))
              yield* fs.rename(tmp, file).pipe(Effect.mapError(asCannotWrite(`replace ${file}`)))
              return next
            }),
            () => releaseLock,
          )

        return StoreWriter.of({ modify })
      }),
    )
}
