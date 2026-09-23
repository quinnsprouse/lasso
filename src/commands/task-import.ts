import { DateTime, Effect, Schema } from "effect"
import { defineMutation } from "../contract/contract.ts"
import { Task, taskId } from "../domain/task.ts"
import { Errors } from "../errors.ts"
import { Progress } from "../output/progress.ts"
import { TaskFeed } from "../services/feed.ts"
import { StoreReader, StoreWriter } from "../services/store.ts"

const Skip = Schema.Struct({
  title: Schema.String,
  reason: Schema.Literals(["already_exists", "repeated_in_feed", "no_identifier"]),
})

// The plan carries what the feed said, so a confirmed import writes exactly
// what was previewed; a feed that changed since then re-plans to a new token.
const ImportPlan = Schema.Struct({
  source: Schema.String,
  adds: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, status: Schema.Literal("open") }),
  ),
  skips: Schema.Array(Skip),
})

type Planned = (typeof ImportPlan.Type)["adds"][number]
type Skipped = typeof Skip.Type

export const taskImport = defineMutation({
  name: "task import",
  summary: "Import tasks from a JSON feed at a URL",
  stability: "experimental",
  idempotency: { kind: "always" },
  params: {
    url: {
      kind: "argument",
      type: "string",
      description: 'HTTP(S) URL of a JSON feed: {"tasks":[{"title":"…"}]}',
    },
  },
  planSchema: ImportPlan,
  dataSchema: Schema.Struct({ imported: Schema.Array(Task), skipped: Schema.Array(Skip) }),
  domainErrorCodes: [
    "auth_failure",
    "not_found",
    "service_unavailable",
    "transient_failure",
    "invalid_config",
    "cannot_write",
  ],
  guides: ["task-ids"],
  examples: [
    {
      command: "lasso task import https://example.com/tasks.json --dry-run --json",
      description: "Preview which tasks the feed would add",
    },
    {
      command: "lasso task import https://example.com/tasks.json --yes --json",
      description: "Import in one step (set LASSO_FEED_TOKEN when the feed needs a token)",
    },
  ],
  plan: Effect.fn("taskImport.plan")(function* (input) {
    const url = URL.parse(input.url)
    if (url === null || !["http:", "https:"].includes(url.protocol)) {
      return yield* Errors.invalidUsage({
        message: `"${input.url}" is not an http(s) URL`,
        fix: "pass the feed's full URL, e.g. https://example.com/tasks.json",
      })
    }
    const progress = yield* Progress
    yield* progress.report({ phase: "fetch", message: `reading ${url.host}` })
    const titles = yield* (yield* TaskFeed).titles(url)
    const existing = new Set((yield* (yield* StoreReader).load).map((task) => task.id))

    const adds: Array<Planned> = []
    const skips: Array<Skipped> = []
    for (const title of titles.map((raw) => raw.trim())) {
      const id = taskId(title)
      if (id === "task_") skips.push({ title, reason: "no_identifier" })
      else if (existing.has(id)) skips.push({ title, reason: "already_exists" })
      else if (adds.some((task) => task.id === id))
        skips.push({ title, reason: "repeated_in_feed" })
      else adds.push({ id, title, status: "open" })
    }
    return { source: url.href, adds, skips }
  }),
  apply: Effect.fn("taskImport.apply")(function* (plan) {
    const writer = yield* StoreWriter
    const createdAt = DateTime.formatIso(yield* DateTime.now)
    const planned = plan.adds.map((task) => new Task({ ...task, createdAt }))
    const tasks = yield* writer.modify((current) => {
      const taken = new Set(current.map((task) => task.id))
      const fresh = planned.filter((task) => !taken.has(task.id))
      return fresh.length === 0 ? null : [...current, ...fresh]
    })
    // Ids another writer created since the plan are skipped, not failed: the
    // import is idempotent, so its outcome is the same either way.
    const imported = planned.filter((task) => tasks.includes(task))
    const raced = planned
      .filter((task) => !tasks.includes(task))
      .map((task): Skipped => ({ title: task.title, reason: "already_exists" }))
    return { imported, skipped: [...plan.skips, ...raced] }
  }),
  next: () => [
    { message: "see the imported tasks", args: ["task", "list", "--status", "all", "--json"] },
  ],
  renderPlanText: (plan) =>
    `Will import ${plan.adds.length} task(s) from ${plan.source}; ${plan.skips.length} skipped`,
  renderText: (data) => `Imported ${data.imported.length} task(s); ${data.skipped.length} skipped`,
})
