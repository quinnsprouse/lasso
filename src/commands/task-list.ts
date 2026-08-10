import { Effect } from "effect"
import { TaskList } from "../domain/task.ts"
import { StoreReader } from "../services/store.ts"
import { defineQuery } from "../contract/contract.ts"

export const taskList = defineQuery({
  name: "task list",
  summary: "List tasks",
  stability: "stable",
  params: {
    status: {
      kind: "flag",
      type: "choice",
      choices: ["open", "done", "all"],
      default: "open",
      description: "Filter tasks by status",
    },
  },
  dataSchema: TaskList,
  domainErrorCodes: ["invalid_config", "cannot_write"],
  examples: [
    {
      command: "lasso task list --status all --json",
      description: "List every task as a JSON envelope",
    },
    {
      command: "lasso task list --format ndjson --fields id,title",
      description: "Stream open tasks as NDJSON, projecting two fields",
    },
  ],
  handler: Effect.fn("taskList.handler")(function* (input) {
    const reader = yield* StoreReader
    const tasks = yield* reader.load
    const items =
      input.status === "all" ? tasks : tasks.filter((task) => task.status === input.status)
    return { items, count: items.length }
  }),
  renderText: (data) =>
    data.items.length === 0
      ? "No tasks found."
      : data.items.map((task) => `[${task.status}] ${task.id}  ${task.title}`).join("\n"),
  collection: {
    fields: ["id", "title", "status", "createdAt"],
    // The encoded payload is the schema-encoded TaskList; rows come from it
    // so JSON, NDJSON, and projection always agree.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    items: (encoded) => (encoded as { items: ReadonlyArray<Record<string, unknown>> }).items,
  },
})
