import { Effect, Layer } from "effect"
import { taskCreate } from "../../src/commands/task-create.ts"
import { Task } from "../../src/domain/task.ts"
import { StoreReader } from "../../src/services/store.ts"
import { planFixture } from "../contract/plan-fixture.ts"

const existing = new Task({
  id: "task_ship",
  title: "Ship",
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
})
const reads = (tasks: ReadonlyArray<Task>) =>
  Layer.succeed(StoreReader, StoreReader.of({ load: Effect.succeed(tasks) }))

// Replace these cases alongside the demo commands. Every mutation needs a successful case.
export const mutationFixtures = [
  planFixture(taskCreate, {
    name: "creates a task",
    input: { title: "Ship", ifNotExists: false },
    layer: reads([]),
    expected: {
      plan: { action: "create_task", task: { id: "task_ship", title: "Ship", status: "open" } },
    },
  }),
  planFixture(taskCreate, {
    name: "creates a missing task with if-not-exists",
    input: { title: "Ship", ifNotExists: true },
    layer: reads([]),
    expected: {
      plan: { action: "create_task", task: { id: "task_ship", title: "Ship", status: "open" } },
    },
  }),
  planFixture(taskCreate, {
    name: "leaves an existing task unchanged",
    input: { title: "Ship", ifNotExists: true },
    layer: reads([existing]),
    expected: { plan: { action: "no_op", reason: "already_exists", taskId: "task_ship" } },
  }),
  planFixture(taskCreate, {
    name: "rejects a duplicate task",
    input: { title: "Ship", ifNotExists: false },
    layer: reads([existing]),
    expected: { error: "resource_conflict" },
  }),
]
