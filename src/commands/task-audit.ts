import { Effect, Schema } from "effect"
import { defineQuery } from "../contract/contract.ts"
import { Progress } from "../output/progress.ts"
import { StoreReader } from "../services/store.ts"

// Example of progress reporting without writing directly to stdout.
export const taskAudit = defineQuery({
  name: "task audit",
  summary: "Check the task store for duplicate ids and count entries",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Struct({
    tasks: Schema.Int,
    duplicateIds: Schema.Int,
  }),
  domainErrorCodes: ["invalid_config", "cannot_write"],
  examples: [
    {
      command: "lasso task audit --format ndjson",
      description: "Audit the store with progress events",
    },
  ],
  handler: Effect.fn("taskAudit.handler")(function* () {
    const progress = yield* Progress
    const reader = yield* StoreReader
    yield* progress.report({ phase: "load", message: "reading the task store" })
    const tasks = yield* reader.load
    yield* progress.report({
      phase: "scan",
      message: "checking ids",
      // Counters require a positive total — an empty store reports uncounted.
      ...(tasks.length > 0 ? { completed: tasks.length, total: tasks.length } : {}),
    })
    const ids = new Set(tasks.map((task) => task.id))
    return { tasks: tasks.length, duplicateIds: tasks.length - ids.size }
  }),
  renderText: (data) =>
    data.duplicateIds === 0
      ? `${data.tasks} task(s), no duplicate ids`
      : `${data.tasks} task(s), ${data.duplicateIds} duplicate id(s)`,
})
