import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { AppError, Errors } from "../errors.ts"
import { Task } from "../domain/task.ts"

const StoreFile = Schema.Struct({
  tasks: Schema.Array(Task),
})

export interface StoreApi {
  readonly load: Effect.Effect<ReadonlyArray<Task>, AppError>
  readonly save: (tasks: ReadonlyArray<Task>) => Effect.Effect<void, AppError>
}

/**
 * A file-backed store scoped to the working directory (`.lasso/tasks.json`).
 * All filesystem access goes through the FileSystem service so tests swap in
 * an in-memory layer — command code never touches `node:fs`.
 */
export class Store extends Context.Service<Store, StoreApi>()("lasso/services/Store") {
  static readonly layer: Layer.Layer<Store, never, FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = ".lasso"
        const file = path.join(dir, "tasks.json")

        const load = Effect.gen(function* () {
          const exists = yield* fs
            .exists(file)
            .pipe(
              Effect.mapError((cause) =>
                Errors.cannotWrite({ message: `cannot access ${file}: ${cause.message}` }),
              ),
            )
          if (!exists) {
            return [] as ReadonlyArray<Task>
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

        const save = (tasks: ReadonlyArray<Task>) =>
          Effect.gen(function* () {
            yield* fs
              .makeDirectory(dir, { recursive: true })
              .pipe(
                Effect.mapError((cause) =>
                  Errors.cannotWrite({ message: `cannot create ${dir}: ${cause.message}` }),
                ),
              )
            const encoded = yield* Schema.encodeEffect(StoreFile)({ tasks }).pipe(
              Effect.mapError((cause) =>
                Errors.invalidData({ message: `tasks failed to encode: ${cause.message}` }),
              ),
            )
            const tmp = `${file}.tmp`
            yield* fs
              .writeFileString(tmp, `${JSON.stringify(encoded, null, 2)}\n`)
              .pipe(
                Effect.mapError((cause) =>
                  Errors.cannotWrite({ message: `cannot write ${tmp}: ${cause.message}` }),
                ),
              )
            yield* fs
              .rename(tmp, file)
              .pipe(
                Effect.mapError((cause) =>
                  Errors.cannotWrite({ message: `cannot replace ${file}: ${cause.message}` }),
                ),
              )
          })

        return Store.of({ load, save })
      }),
    )
}
