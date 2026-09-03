import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Task } from "../../src/domain/task.ts"
import { StoreReader, StoreWriter } from "../../src/services/store.ts"
import { taskCreate } from "../../src/commands/task-create.ts"

/**
 * The service-layer pattern: plan runs against a fake StoreReader, apply
 * against a fake StoreWriter — no filesystem, no CLI process. The read/write
 * split is itself under test: plan cannot write because no writer exists in
 * its environment.
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
  it("derives a deterministic, self-contained plan", async () => {
    const plan = await Effect.runPromise(
      taskCreate.plan(input("Write the docs")).pipe(Effect.provide(readerWith([]))),
    )
    expect(plan).toEqual({
      action: "create_task",
      task: { id: "task_write-the-docs", title: "Write the docs", status: "open" },
    })
  })

  it("models the --if-not-exists no-op in the plan itself", async () => {
    const plan = await Effect.runPromise(
      taskCreate
        .plan(input("Dup", true))
        .pipe(Effect.provide(readerWith([seed("task_dup", "Dup")]))),
    )
    expect(plan).toEqual({ action: "no_op", reason: "already_exists", taskId: "task_dup" })
  })

  it("rejects empty titles as invalid_data with a fix", async () => {
    const error = await Effect.runPromise(
      taskCreate.plan(input("   ")).pipe(Effect.flip, Effect.provide(readerWith([]))),
    )
    expect(error.code).toBe("invalid_data")
    expect(error.exit).toBe(65)
    expect(error.fix).toBeDefined()
  })

  it("rejects a title that derives no identifier", async () => {
    const error = await Effect.runPromise(
      taskCreate.plan(input("日本語")).pipe(Effect.flip, Effect.provide(readerWith([]))),
    )
    expect(error.code).toBe("invalid_data")
    expect(error.fix).toContain("ASCII")
  })

  it("conflicts at plan time when the task exists", async () => {
    const error = await Effect.runPromise(
      taskCreate
        .plan(input("Dup"))
        .pipe(Effect.flip, Effect.provide(readerWith([seed("task_dup", "Dup")]))),
    )
    expect(error.code).toBe("resource_conflict")
    expect(error.transient).toBe(false)
  })
})

describe("task create apply", () => {
  it("persists exactly the planned task", async () => {
    const { layer, states } = writerWith([])
    const result = await Effect.runPromise(
      taskCreate
        .apply({
          action: "create_task",
          task: { id: "task_x", title: "X", status: "open" },
        })
        .pipe(Effect.provide(layer)),
    )
    expect(result.created).toBe(true)
    expect(states.at(-1)!.map((task) => task.id)).toEqual(["task_x"])
  })

  it("executes a no_op plan without changing state", async () => {
    const { layer, states } = writerWith([seed("task_idem", "Idem")])
    const result = await Effect.runPromise(
      taskCreate
        .apply({ action: "no_op", reason: "already_exists", taskId: "task_idem" })
        .pipe(Effect.provide(layer)),
    )
    expect(result.created).toBe(false)
    expect(result.task.id).toBe("task_idem")
    // No write at all: the transform returned null, so the store kept its identity.
    expect(states.length).toBe(1)
  })

  it("reports a conflict when another process created the task after planning", async () => {
    const { layer, states } = writerWith([seed("task_x", "X")])
    const error = await Effect.runPromise(
      taskCreate
        .apply({
          action: "create_task",
          task: { id: "task_x", title: "X", status: "open" },
        })
        .pipe(Effect.flip, Effect.provide(layer)),
    )
    expect(error.code).toBe("resource_conflict")
    // A rejected mutation performs no write at all.
    expect(states.length).toBe(1)
  })
})
