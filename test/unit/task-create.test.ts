import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Task } from "../../src/domain/task.ts"
import { Store } from "../../src/services/store.ts"
import { taskCreate } from "../../src/commands/task-create.ts"

/**
 * The service-layer pattern: handlers never touch the filesystem, so a test
 * provides an in-memory Store and runs plan/apply as plain Effects.
 */

const storeWith = (initial: ReadonlyArray<Task>) => {
  const saved: Array<ReadonlyArray<Task>> = []
  const layer = Layer.succeed(
    Store,
    Store.of({
      load: Effect.sync(() => saved.at(-1) ?? initial),
      save: (tasks) => Effect.sync(() => void saved.push(tasks)),
    }),
  )
  return { layer, saved }
}

const runWith = <A, E>(effect: Effect.Effect<A, E, Store>, layer: Layer.Layer<Store>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const input = (title: string, ifNotExists = false) => ({ title, ifNotExists })

describe("task create planning", () => {
  it("derives a deterministic plan from intent", async () => {
    const { layer } = storeWith([])
    const plan = await runWith(taskCreate.plan(input("Write the docs")), layer)
    expect(plan).toEqual({
      action: "create_task",
      task: { id: "task_write-the-docs", title: "Write the docs", status: "open" },
    })
  })

  it("rejects empty titles as invalid_data with a fix", async () => {
    const { layer } = storeWith([])
    const error = await runWith(taskCreate.plan(input("   ")).pipe(Effect.flip), layer)
    expect(error.code).toBe("invalid_data")
    expect(error.exit).toBe(65)
    expect(error.fix).toBeDefined()
  })

  it("conflicts at plan time when the task exists", async () => {
    const existing = new Task({
      id: "task_dup",
      title: "Dup",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const { layer } = storeWith([existing])
    const error = await runWith(taskCreate.plan(input("Dup")).pipe(Effect.flip), layer)
    expect(error.code).toBe("resource_conflict")
    expect(error.transient).toBe(false)
  })

  it("apply persists exactly the planned task", async () => {
    const { layer, saved } = storeWith([])
    const plan = await runWith(taskCreate.plan(input("Persist me")), layer)
    const result = await runWith(taskCreate.apply(plan, input("Persist me")), layer)
    expect(result.created).toBe(true)
    expect(saved.length).toBe(1)
    expect(saved[0]![0]!.id).toBe("task_persist-me")
  })

  it("apply with --if-not-exists is a no-op on an existing task", async () => {
    const existing = new Task({
      id: "task_idem",
      title: "Idem",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const { layer, saved } = storeWith([existing])
    const plan = await runWith(taskCreate.plan(input("Idem", true)), layer)
    const result = await runWith(taskCreate.apply(plan, input("Idem", true)), layer)
    expect(result.created).toBe(false)
    expect(saved.length).toBe(0)
  })
})
