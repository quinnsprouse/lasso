import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { taskList } from "../../src/commands/task-list.ts"
import { Task } from "../../src/domain/task.ts"
import { StoreReader } from "../../src/services/store.ts"

const seed = (id: string, status: "open" | "done") =>
  new Task({ id, title: id, status, createdAt: "2026-01-01T00:00:00.000Z" })

const readerWith = (tasks: ReadonlyArray<Task>) =>
  Layer.succeed(StoreReader, StoreReader.of({ load: Effect.succeed(tasks) }))

const run = (status: "open" | "done" | "all", tasks: ReadonlyArray<Task>) =>
  Effect.runPromise(taskList.handler({ status }).pipe(Effect.provide(readerWith(tasks))))

describe("task list", () => {
  it("filters by status and counts", async () => {
    const tasks = [seed("task_a", "open"), seed("task_b", "done")]
    expect((await run("open", tasks)).items.map((task) => task.id)).toEqual(["task_a"])
    expect((await run("done", tasks)).count).toBe(1)
    expect((await run("all", tasks)).count).toBe(2)
  })

  it("renders human text for both empty and populated lists", () => {
    expect(taskList.renderText!({ items: [], count: 0 })).toBe("No tasks found.")
    expect(taskList.renderText!({ items: [seed("task_a", "open")], count: 1 })).toContain(
      "[open] task_a",
    )
  })

  it("extracts collection rows from the encoded payload", () => {
    const rows = taskList.collection!.items({ items: [{ id: "task_a" }] })
    expect(rows).toEqual([{ id: "task_a" }])
  })
})
