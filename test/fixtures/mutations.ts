import { Effect, Layer } from "effect"
import { taskCreate } from "../../src/commands/task-create.ts"
import { taskImport } from "../../src/commands/task-import.ts"
import { Task } from "../../src/domain/task.ts"
import { Progress } from "../../src/output/progress.ts"
import { TaskFeed } from "../../src/services/feed.ts"
import { StoreReader } from "../../src/services/store.ts"
import { planFixture } from "../contract/plan-fixture.ts"
// generator:imports — scripts/new-command.mjs --mutation inserts above this line

const existing = new Task({
  id: "task_ship",
  title: "Ship",
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
})
const reads = (tasks: ReadonlyArray<Task>) =>
  Layer.succeed(StoreReader, StoreReader.of({ load: Effect.succeed(tasks) }))

const feed = (titles: ReadonlyArray<string>, tasks: ReadonlyArray<Task>) =>
  Layer.mergeAll(
    reads(tasks),
    Layer.succeed(TaskFeed, TaskFeed.of({ titles: () => Effect.succeed(titles) })),
    Layer.succeed(Progress, Progress.of({ report: () => Effect.void })),
  )

// Replace these cases alongside the demo commands. Every mutation needs a successful case.
export const mutationFixtures = [
  planFixture(taskCreate, {
    name: "creates a task",
    input: { title: "Ship", ifNotExists: false },
    layer: reads([]),
    expected: {
      plan: {
        action: "create_task",
        task: { id: "task_ship", title: "Ship", status: "open" },
        ifExists: "fail",
      },
    },
  }),
  planFixture(taskCreate, {
    name: "creates a missing task with if-not-exists",
    input: { title: "Ship", ifNotExists: true },
    layer: reads([]),
    expected: {
      plan: {
        action: "create_task",
        task: { id: "task_ship", title: "Ship", status: "open" },
        ifExists: "skip",
      },
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
  planFixture(taskImport, {
    name: "imports new titles and says why it skips the rest",
    input: { url: "https://feed.test/tasks.json" },
    layer: feed(["Ship", "Write docs", " Write docs ", "!!!"], [existing]),
    expected: {
      plan: {
        source: "https://feed.test/tasks.json",
        adds: [{ id: "task_write-docs", title: "Write docs", status: "open" }],
        skips: [
          { title: "Ship", reason: "already_exists" },
          { title: "Write docs", reason: "repeated_in_feed" },
          { title: "!!!", reason: "no_identifier" },
        ],
      },
    },
  }),
  planFixture(taskImport, {
    name: "rejects a URL that is not http(s)",
    input: { url: "file:///etc/passwd" },
    layer: feed([], []),
    expected: { error: "invalid_usage" },
  }),
  // generator:fixtures — scripts/new-command.mjs --mutation inserts above this line
]
