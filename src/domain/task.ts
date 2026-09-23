import { Schema } from "effect"

/**
 * The demo domain. Replace this with your own — it exists so the kit's
 * patterns (query, mutation, plan, store) have something real to exercise,
 * and so the Starter Contract has a surface to verify.
 */
export class Task extends Schema.Class<Task>("lasso/domain/Task")({
  id: Schema.String,
  title: Schema.NonEmptyString,
  status: Schema.Literals(["open", "done"]),
  createdAt: Schema.String,
}) {}

export const TaskList = Schema.Struct({
  items: Schema.Array(Task),
  count: Schema.Int,
})

/**
 * Identifiers are semantic and human-readable, never opaque UUIDs. The steps
 * are documented in guides/topics/task-ids.md; keep the two in step.
 */
export const taskId = (title: string): string =>
  `task_${title
    .normalize("NFC")
    .replace(/[^\p{ASCII}]+/gu, "-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")}`
