import { Clock, Context, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect"
import { AppError, Errors } from "../errors.ts"
import { Task } from "../domain/task.ts"

const StoreFile = Schema.Struct({
  tasks: Schema.Array(Task),
})

/**
 * Read and write capabilities are separate services: `plan` handlers get
 * StoreReader, `apply` handlers get StoreWriter. A mutation that tries to
 * write during planning does not typecheck.
 *
 * Writes go through `modify` — an atomic read-transform-write under an
 * advisory lock, so concurrent agent invocations cannot tear or lose data.
 */

export interface StoreReaderApi {
  readonly load: Effect.Effect<ReadonlyArray<Task>, AppError>
}

export interface StoreWriterApi {
  readonly modify: (
    transform: (tasks: ReadonlyArray<Task>) => ReadonlyArray<Task>,
  ) => Effect.Effect<ReadonlyArray<Task>, AppError>
}

const asCannotWrite = (what: string) => (cause: { message: string }) =>
  Errors.cannotWrite({ message: `cannot ${what}: ${cause.message}` })

const DIR = ".lasso"
const FILE = "tasks.json"
const LOCK = "tasks.lock"

// Uniquifies temp files within one process; the lock serializes across processes.
let tmpCounter = 0

const loadFrom = Effect.fn("store.load")(function* (fs: FileSystem.FileSystem, file: string) {
  const exists = yield* fs
    .exists(file)
    .pipe(
      Effect.mapError((cause) =>
        Errors.cannotWrite({ message: `cannot access ${file}: ${cause.message}` }),
      ),
    )
  if (!exists) {
    return []
  }
  const raw = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError((cause) =>
        Errors.cannotWrite({ message: `cannot read ${file}: ${cause.message}` }),
      ),
    )
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () =>
      Errors.config({
        message: `${file} is not valid JSON`,
        fix: `inspect ${file} and repair or delete it`,
      }),
  })
  const decoded = yield* Schema.decodeUnknownEffect(StoreFile)(parsed).pipe(
    Effect.mapError((cause) =>
      Errors.config({
        message: `${file} does not match the store schema: ${cause.message}`,
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

        // Advisory lock via exclusive directory creation; retried briefly so
        // concurrent invocations queue instead of corrupting each other.
        const acquireLock = Effect.gen(function* () {
          yield* fs
            .makeDirectory(DIR, { recursive: true })
            .pipe(Effect.mapError(asCannotWrite(`create ${DIR}`)))
          yield* fs.makeDirectory(lock).pipe(
            Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 40 }),
            Effect.mapError(() =>
              Errors.transient({
                message: "the task store is locked by another process",
                fix: `retry; if it persists, remove the stale ${lock} directory`,
              }),
            ),
          )
        })

        const releaseLock = fs.remove(lock, { recursive: true }).pipe(Effect.ignore)

        const modify: StoreWriterApi["modify"] = (transform) =>
          Effect.acquireUseRelease(
            acquireLock,
            () =>
              Effect.gen(function* () {
                const current = yield* loadFrom(fs, file)
                const next = transform(current)
                const encoded = yield* Schema.encodeEffect(StoreFile)({ tasks: next }).pipe(
                  Effect.mapError((cause) =>
                    Errors.invalidData({ message: `tasks failed to encode: ${cause.message}` }),
                  ),
                )
                const stamp = yield* Clock.currentTimeMillis
                tmpCounter += 1
                const tmp = `${file}.${stamp.toString(36)}.${tmpCounter}.tmp`
                yield* fs
                  .writeFileString(tmp, `${JSON.stringify(encoded, null, 2)}\n`)
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
