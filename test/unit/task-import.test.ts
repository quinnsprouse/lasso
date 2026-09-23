import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { taskImport } from "../../src/commands/task-import.ts"
import { Task } from "../../src/domain/task.ts"
import { StoreWriter } from "../../src/services/store.ts"

// Planning is covered by the plan fixtures (test/fixtures/mutations.ts); these
// cover apply against a fake StoreWriter.

const plan = {
  source: "https://feed.test/tasks.json",
  adds: [
    { id: "task_a", title: "A", status: "open" as const },
    { id: "task_b", title: "B", status: "open" as const },
  ],
  skips: [{ title: "!!!", reason: "no_identifier" as const }],
}

const writerWith = (initial: ReadonlyArray<Task>) => {
  const states: Array<ReadonlyArray<Task>> = [initial]
  const layer = Layer.succeed(
    StoreWriter,
    StoreWriter.of({
      modify: (transform) =>
        Effect.sync(() => {
          const { next, result } = transform(states.at(-1)!)
          if (next !== null) states.push(next)
          return result
        }),
    }),
  )
  return { layer, states }
}

describe("task import apply", () => {
  it.effect("writes the planned tasks, stamped at apply time", () => {
    const { layer, states } = writerWith([])
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-05-06T07:08:09.000Z"))
      const result = yield* taskImport.apply(plan)
      expect(result.imported.map((task) => task.id)).toEqual(["task_a", "task_b"])
      expect(result.imported[0]!.createdAt).toBe("2026-05-06T07:08:09.000Z")
      expect(result.skipped).toEqual(plan.skips)
      expect(states.length).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("skips ids another writer created since the plan, instead of failing", () => {
    const winner = new Task({ id: "task_b", title: "B", status: "open", createdAt: "x" })
    const { layer } = writerWith([winner])
    return Effect.gen(function* () {
      const result = yield* taskImport.apply(plan)
      expect(result.imported.map((task) => task.id)).toEqual(["task_a"])
      expect(result.skipped).toContainEqual({ title: "B", reason: "already_exists" })
    }).pipe(Effect.provide(layer))
  })

  it.effect("writes nothing when every planned id already exists", () => {
    const { layer, states } = writerWith([
      new Task({ id: "task_a", title: "A", status: "open", createdAt: "x" }),
      new Task({ id: "task_b", title: "B", status: "open", createdAt: "x" }),
    ])
    return Effect.gen(function* () {
      const result = yield* taskImport.apply(plan)
      expect(result.imported).toEqual([])
      expect(states.length).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
