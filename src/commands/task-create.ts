import { Clock, Effect, Schema } from "effect"
import { Task, taskId } from "../domain/task.ts"
import { Store } from "../services/store.ts"
import { Errors } from "../errors.ts"
import { defineMutation } from "../contract/contract.ts"
import { register } from "../contract/registry.ts"

const CreatePlan = Schema.Struct({
  action: Schema.Literal("create_task"),
  task: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    status: Schema.Literal("open"),
  }),
})

/**
 * The mutation pattern: `plan` derives intent without side effects, `apply`
 * executes exactly that plan. The runtime owns --dry-run, --confirm, --yes.
 */
export const taskCreate = register(
  defineMutation({
    name: "task create",
    summary: "Create a task",
    stability: "stable",
    idempotent: true,
    params: {
      title: {
        kind: "argument",
        type: "string",
        description: "Task title",
      },
      ifNotExists: {
        kind: "flag",
        type: "boolean",
        description: "Succeed without changes when the task already exists",
      },
    },
    planSchema: CreatePlan,
    output: Schema.Struct({
      created: Schema.Boolean,
      task: Task,
    }),
    errorCodes: ["resource_conflict", "invalid_data", "cannot_write", "stale_confirmation"],
    examples: [
      {
        command: 'lasso task create "Ship the kit" --yes --json',
        description: "Create a task in one non-interactive step",
      },
      {
        command: 'lasso task create "Ship the kit" --dry-run --json',
        description: "Preview the plan without changing anything",
      },
    ],
    plan: (input) =>
      Effect.gen(function* () {
        const title = input.title.trim()
        if (title.length === 0) {
          return yield* Errors.invalidData({
            message: "task title must not be empty",
            fix: 'pass a non-empty title, e.g. lasso task create "Write docs"',
          })
        }
        const id = taskId(title)
        const store = yield* Store
        const tasks = yield* store.load
        const existing = tasks.find((task) => task.id === id)
        if (existing !== undefined && !input.ifNotExists) {
          return yield* Errors.conflict({
            message: `task "${id}" already exists`,
            fix: `re-run with --if-not-exists to make this a no-op`,
          })
        }
        return {
          action: "create_task" as const,
          task: { id, title, status: "open" as const },
        }
      }),
    apply: (plan, input) =>
      Effect.gen(function* () {
        const store = yield* Store
        const tasks = yield* store.load
        const existing = tasks.find((task) => task.id === plan.task.id)
        if (existing !== undefined) {
          if (input.ifNotExists) {
            return { created: false, task: existing }
          }
          return yield* Errors.conflict({
            message: `task "${plan.task.id}" already exists`,
            fix: `re-run with --if-not-exists to make this a no-op`,
          })
        }
        const now = yield* Clock.currentTimeMillis
        const task = new Task({
          ...plan.task,
          createdAt: new Date(now).toISOString(),
        })
        yield* store.save([...tasks, task])
        return { created: true, task }
      }),
    render: (data) =>
      data.created
        ? `Created ${data.task.id}: ${data.task.title}`
        : `Unchanged — ${data.task.id} already exists`,
    renderPlan: (plan) => `Will create task ${plan.task.id}: "${plan.task.title}"`,
  }),
)
