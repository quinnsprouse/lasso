import { Clock, DateTime, Effect, Schema } from "effect"
import { Task, taskId } from "../domain/task.ts"
import { StoreReader, StoreWriter } from "../services/store.ts"
import { Errors } from "../errors.ts"
import { defineMutation } from "../contract/contract.ts"

// The no-op decision belongs in the confirmed plan, not in apply-time flags.

const CreatePlan = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create_task"),
    task: Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      status: Schema.Literal("open"),
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("no_op"),
    reason: Schema.Literal("already_exists"),
    taskId: Schema.String,
  }),
])

export const taskCreate = defineMutation({
  name: "task create",
  summary: "Create a task",
  stability: "stable",
  idempotency: { kind: "conditional", parameter: "ifNotExists" },
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
  dataSchema: Schema.Struct({
    created: Schema.Boolean,
    task: Task,
  }),
  domainErrorCodes: [
    "resource_conflict",
    "invalid_data",
    "cannot_write",
    "invalid_config",
    "transient_failure",
  ],
  guides: ["task-ids", "mutation-replay"],
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
  plan: Effect.fn("taskCreate.plan")(function* (input) {
    const title = input.title.trim()
    if (title.length === 0) {
      return yield* Errors.invalidData({
        message: "task title must not be empty",
        fix: 'pass a non-empty title, e.g. lasso task create "Write docs"',
      })
    }
    const id = taskId(title)
    if (id === "task_") {
      return yield* Errors.invalidData({
        message: `task title "${title}" yields no identifier: it has no ASCII letters or digits`,
        fix: "include at least one ASCII letter or digit in the title",
      })
    }
    const reader = yield* StoreReader
    const tasks = yield* reader.load
    const existing = tasks.find((task) => task.id === id)
    if (existing !== undefined) {
      if (input.ifNotExists) {
        return { action: "no_op" as const, reason: "already_exists" as const, taskId: id }
      }
      return yield* Errors.resourceConflict({
        message: `task "${id}" already exists`,
        fix: "re-run with --if-not-exists to make this a no-op",
        next: [
          {
            message: "see the existing task",
            args: ["task", "list", "--status", "all", "--json"],
          },
          {
            message: "make this create a no-op (preview first)",
            // The title goes after "--" so a title that starts with "-" is not a flag.
            args: ["task", "create", "--if-not-exists", "--json", "--", input.title],
          },
        ],
      })
    }
    // Assign timestamps in apply so identical plans keep the same confirmation token.
    return {
      action: "create_task" as const,
      task: { id, title, status: "open" as const },
    }
  }),
  apply: Effect.fn("taskCreate.apply")(function* (plan) {
    const writer = yield* StoreWriter
    if (plan.action === "no_op") {
      // null avoids a write that would notify file watchers on a no-op.
      const tasks = yield* writer.modify(() => null)
      const existing = tasks.find((task) => task.id === plan.taskId)
      if (existing === undefined) {
        return yield* Errors.staleConfirmation({
          message: `task "${plan.taskId}" no longer exists — the no-op plan is stale`,
          fix: "re-run without --confirm to get a fresh plan",
        })
      }
      return { created: false, task: existing }
    }
    const now = yield* Clock.currentTimeMillis
    const task = new Task({ ...plan.task, createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)) })
    let conflicted = false
    const tasks = yield* writer.modify((current) => {
      if (current.some((existing) => existing.id === task.id)) {
        // null: nothing is written, so a rejected mutation leaves the file untouched.
        conflicted = true
        return null
      }
      return [...current, task]
    })
    if (conflicted) {
      return yield* Errors.resourceConflict({
        message: `task "${task.id}" was created by another process`,
        fix: "re-run with --if-not-exists to make this a no-op",
      })
    }
    const created = tasks.find((existing) => existing.id === task.id)
    return { created: true, task: created ?? task }
  }),
  next: ({ data }) => [
    {
      message: data.created ? "see the new task in the list" : "see the existing task",
      args: ["task", "list", "--status", "all", "--json"],
    },
  ],
  renderText: (data) =>
    data.created
      ? `Created ${data.task.id}: ${data.task.title}`
      : `Unchanged — ${data.task.id} already exists`,
  renderPlanText: (plan) =>
    plan.action === "no_op"
      ? `No changes: task ${plan.taskId} already exists`
      : `Will create task ${plan.task.id}: "${plan.task.title}"`,
})
