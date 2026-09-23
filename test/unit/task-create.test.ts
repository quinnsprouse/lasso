import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Task } from "../../src/domain/task.ts"
import { StoreReader, StoreWriter } from "../../src/services/store.ts"
import { taskCreate } from "../../src/commands/task-create.ts"

/**
 * The service-layer pattern: plan runs against a fake StoreReader, apply
 * against a fake StoreWriter — no filesystem, no CLI process. The read/write
 * split is itself under test: plan cannot write because no writer exists in
 * its environment. `it.effect` runs each test under TestClock, so time is
 * whatever the test sets.
 */

const seed = (id: string, title: string) =>
  new Task({ id, title, status: "open", createdAt: "2026-01-01T00:00:00.000Z" })

const readerWith = (tasks: ReadonlyArray<Task>) =>
  Layer.succeed(StoreReader, StoreReader.of({ load: Effect.succeed(tasks) }))

const writerWith = (initial: ReadonlyArray<Task>) => {
  const states: Array<ReadonlyArray<Task>> = [initial]
  const layer = Layer.succeed(
    StoreWriter,
    StoreWriter.of({
      modify: (transform) =>
        Effect.sync(() => {
          const next = transform(states.at(-1)!)
          if (next === null) {
            return states.at(-1)!
          }
          states.push(next)
          return next
        }),
    }),
  )
  return { layer, states }
}

const input = (title: string, ifNotExists = false) => ({ title, ifNotExists })

describe("task create plan", () => {
  it.effect("derives a deterministic, self-contained plan", () =>
    Effect.gen(function* () {
      const plan = yield* taskCreate.plan(input("Write the docs"))
      expect(plan).toEqual({
        action: "create_task",
        task: { id: "task_write-the-docs", title: "Write the docs", status: "open" },
        ifExists: "fail",
      })
    }).pipe(Effect.provide(readerWith([]))),
  )

  it.effect("models the --if-not-exists no-op in the plan itself", () =>
    Effect.gen(function* () {
      const plan = yield* taskCreate.plan(input("Dup", true))
      expect(plan).toEqual({ action: "no_op", reason: "already_exists", taskId: "task_dup" })
    }).pipe(Effect.provide(readerWith([seed("task_dup", "Dup")]))),
  )

  it.effect("rejects empty titles as invalid_data with a fix", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(taskCreate.plan(input("   ")))
      expect(error.code).toBe("invalid_data")
      expect(error.exit).toBe(65)
      expect(error.fix).toBeDefined()
    }).pipe(Effect.provide(readerWith([]))),
  )

  it.effect("rejects a title that derives no identifier", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(taskCreate.plan(input("日本語")))
      expect(error.code).toBe("invalid_data")
      expect(error.fix).toContain("ASCII")
    }).pipe(Effect.provide(readerWith([]))),
  )

  it.effect("conflicts at plan time when the task exists", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(taskCreate.plan(input("Dup")))
      expect(error.code).toBe("resource_conflict")
      expect(error.transient).toBe(false)
    }).pipe(Effect.provide(readerWith([seed("task_dup", "Dup")]))),
  )
})

describe("task create apply", () => {
  it.effect("persists exactly the planned task", () => {
    const { layer, states } = writerWith([])
    return Effect.gen(function* () {
      const result = yield* taskCreate.apply({
        action: "create_task",
        task: { id: "task_x", title: "X", status: "open" },
        ifExists: "fail",
      })
      expect(result.created).toBe(true)
      expect(states.at(-1)!.map((task) => task.id)).toEqual(["task_x"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("stamps createdAt at apply time, from the clock", () => {
    const { layer } = writerWith([])
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-03-04T05:06:07.000Z"))
      const result = yield* taskCreate.apply({
        action: "create_task",
        task: { id: "task_x", title: "X", status: "open" },
        ifExists: "fail",
      })
      expect(result.task.createdAt).toBe("2026-03-04T05:06:07.000Z")
    }).pipe(Effect.provide(layer))
  })

  it.effect("executes a no_op plan without changing state", () => {
    const { layer, states } = writerWith([seed("task_idem", "Idem")])
    return Effect.gen(function* () {
      const result = yield* taskCreate.apply({
        action: "no_op",
        reason: "already_exists",
        taskId: "task_idem",
      })
      expect(result.created).toBe(false)
      expect(result.task.id).toBe("task_idem")
      // No write at all: the transform returned null, so the store kept its identity.
      expect(states.length).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("with --if-not-exists, losing a race to another writer is the promised no-op", () => {
    const { layer, states } = writerWith([seed("task_x", "X")])
    return Effect.gen(function* () {
      const result = yield* taskCreate.apply({
        action: "create_task",
        task: { id: "task_x", title: "X", status: "open" },
        ifExists: "skip",
      })
      expect(result).toEqual({ created: false, task: seed("task_x", "X") })
      expect(states.length).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("reports a conflict when another process created the task after planning", () => {
    const { layer, states } = writerWith([seed("task_x", "X")])
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        taskCreate.apply({
          action: "create_task",
          task: { id: "task_x", title: "X", status: "open" },
          ifExists: "fail",
        }),
      )
      expect(error.code).toBe("resource_conflict")
      // A rejected mutation performs no write at all.
      expect(states.length).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
