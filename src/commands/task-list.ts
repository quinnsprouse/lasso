import { Effect } from "effect"
import { TaskList } from "../domain/task.ts"
import { Store } from "../services/store.ts"
import { defineQuery } from "../contract/contract.ts"
import { register } from "../contract/registry.ts"

export const taskList = register(
  defineQuery({
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
    output: TaskList,
    errorCodes: ["invalid_config", "cannot_write"],
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
    handler: (input) =>
      Effect.gen(function* () {
        const store = yield* Store
        const tasks = yield* store.load
        const items =
          input.status === "all" ? tasks : tasks.filter((task) => task.status === input.status)
        return { items, count: items.length }
      }),
    render: (data) =>
      data.items.length === 0
        ? "No tasks found."
        : data.items.map((task) => `[${task.status}] ${task.id}  ${task.title}`).join("\n"),
    items: (data) =>
      data.items.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        createdAt: task.createdAt,
      })),
  }),
)
