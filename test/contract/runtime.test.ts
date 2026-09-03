import { Console, Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineMutation, defineQuery } from "../../src/contract/contract.ts"
import type { OutputMode } from "../../src/output/format.ts"
import { Progress } from "../../src/output/progress.ts"
import { StoreReader } from "../../src/services/store.ts"
import { Task } from "../../src/domain/task.ts"
import { taskCreate } from "../../src/commands/task-create.ts"
import { taskList } from "../../src/commands/task-list.ts"
import { lines, makeInvoke } from "./harness.ts"

/**
 * The outcome matrix: the ENTIRE runtime — parser, contract adapter,
 * renderer, exit settlement — run in-process against test layers. This is
 * where the mutation state machine and stream-shape guarantees are proven,
 * without ever spawning the binary.
 */

const counters = { plan: 0, apply: 0 }
let lastPlanInput: Record<string, unknown> = {}

const CounterPlan = Schema.Struct({ value: Schema.Int })

const counterMutation = defineMutation({
  name: "counter bump",
  summary: "Test mutation with plan/apply counters",
  stability: "experimental",
  params: {
    value: {
      kind: "flag",
      type: "integer",
      default: 1,
      description: "Value to record in the plan",
    },
  },
  planSchema: CounterPlan,
  dataSchema: Schema.Struct({ applied: Schema.Int }),
  idempotency: { kind: "none" },
  domainErrorCodes: [],
  examples: [{ command: "lasso counter bump --json", description: "bump" }],
  plan: (input) =>
    Effect.sync(() => {
      counters.plan += 1
      lastPlanInput = { ...input }
      return { value: input.value }
    }),
  apply: (plan) =>
    Effect.sync(() => {
      counters.apply += 1
      return { applied: plan.value }
    }),
})

const failingQuery = defineQuery({
  name: "counter fail",
  summary: "Test query that fails with details",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Unknown,
  domainErrorCodes: ["invalid_data"],
  examples: [{ command: "lasso counter fail --json", description: "fail" }],
  handler: () =>
    Effect.gen(function* () {
      const { Errors } = yield* Effect.promise(() => import("../../src/errors.ts"))
      return yield* Errors.invalidData({
        message: "bad payload",
        fix: "send a good payload",
        details: { field: "x" },
      })
    }),
})

const listQuery = defineQuery({
  name: "counter list",
  summary: "Test collection query",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Struct({ items: Schema.Array(Task), count: Schema.Int }),
  domainErrorCodes: [],
  examples: [{ command: "lasso counter list --json", description: "list" }],
  handler: () =>
    Effect.gen(function* () {
      const reader = yield* StoreReader
      const items = yield* reader.load
      return { items, count: items.length }
    }),
  collection: {
    fields: ["id", "title", "status", "createdAt"],
    items: (encoded) => (encoded as { items: ReadonlyArray<Record<string, unknown>> }).items,
  },
})

const argsQuery = defineQuery({
  name: "counter args",
  summary: "Test argument types",
  stability: "experimental",
  params: {
    count: { kind: "argument", type: "integer", description: "How many" },
    level: {
      kind: "argument",
      type: "choice",
      choices: ["low", "high"],
      description: "Which level",
    },
    target: { kind: "argument", type: "path", description: "Where" },
  },
  dataSchema: Schema.Struct({
    count: Schema.Int,
    level: Schema.String,
    target: Schema.String,
  }),
  domainErrorCodes: [],
  examples: [{ command: "lasso counter args 2 low ./x --json", description: "args" }],
  handler: (input) => Effect.succeed(input),
})

const progressQuery = defineQuery({
  name: "counter slow",
  summary: "Test query that reports progress",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Struct({ done: Schema.Boolean }),
  domainErrorCodes: [],
  examples: [{ command: "lasso counter slow --json", description: "slow" }],
  handler: () =>
    Effect.gen(function* () {
      const progress = yield* Progress
      yield* progress.report({ phase: "warm-up", message: "starting" })
      yield* progress.report({ phase: "main", message: "working", completed: 2, total: 4 })
      return { done: true }
    }),
})

const progressFailQuery = defineQuery({
  name: "counter slowfail",
  summary: "Progress then an expected failure",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Unknown,
  domainErrorCodes: ["invalid_data"],
  examples: [{ command: "lasso counter slowfail --json", description: "fail" }],
  handler: () =>
    Effect.gen(function* () {
      const progress = yield* Progress
      yield* progress.report({ phase: "warm-up", message: "starting" })
      const { Errors } = yield* Effect.promise(() => import("../../src/errors.ts"))
      return yield* Errors.invalidData({ message: "went bad after progress", fix: "none" })
    }),
})

const progressMutation = defineMutation({
  name: "counter slowbump",
  summary: "Progress during planning",
  stability: "experimental",
  params: {},
  planSchema: Schema.Struct({ ready: Schema.Boolean }),
  dataSchema: Schema.Struct({ applied: Schema.Boolean }),
  idempotency: { kind: "none" },
  domainErrorCodes: [],
  examples: [{ command: "lasso counter slowbump --json", description: "bump" }],
  plan: () =>
    Effect.gen(function* () {
      const progress = yield* Progress
      yield* progress.report({ phase: "survey", message: "planning" })
      return { ready: true }
    }),
  apply: () => Effect.succeed({ applied: true }),
})

const progressListQuery = defineQuery({
  name: "counter slowlist",
  summary: "Progress then collection items",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Struct({ items: Schema.Array(Task), count: Schema.Int }),
  domainErrorCodes: [],
  examples: [{ command: "lasso counter slowlist --json", description: "list" }],
  handler: () =>
    Effect.gen(function* () {
      const progress = yield* Progress
      yield* progress.report({ phase: "load", message: "loading" })
      const reader = yield* StoreReader
      const items = yield* reader.load
      return { items, count: items.length }
    }),
  collection: {
    fields: ["id", "title", "status", "createdAt"],
    items: (encoded) => (encoded as { items: ReadonlyArray<Record<string, unknown>> }).items,
  },
})

const badProgressQuery = defineQuery({
  name: "counter badprogress",
  summary: "Invalid progress counters are a defect",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Unknown,
  domainErrorCodes: [],
  examples: [{ command: "lasso counter badprogress --json", description: "bad" }],
  handler: () =>
    Effect.gen(function* () {
      const progress = yield* Progress
      yield* progress.report({ phase: "oops", message: "bad counters", completed: 5, total: 2 })
      return {}
    }),
})

const consoleLeakQuery = defineQuery({
  name: "counter leak",
  summary: "A handler that logs through Effect's Console",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Struct({ ok: Schema.Boolean }),
  domainErrorCodes: [],
  examples: [{ command: "lasso counter leak --json", description: "leak" }],
  handler: () =>
    Effect.gen(function* () {
      yield* Console.log("debug leak")
      yield* Console.debug("debug leak")
      yield* Console.info("debug leak")
      yield* Console.warn("debug leak")
      yield* Console.table([{ leak: true }])
      yield* Console.dir({ leak: true })
      return { ok: true }
    }),
})

/** A progress effect a handler built but did not run before returning. */
let lateProgress: Effect.Effect<void> | undefined
const lateProgressQuery = defineQuery({
  name: "counter late",
  summary: "Builds a progress effect and leaves it for later",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Struct({ done: Schema.Boolean }),
  domainErrorCodes: [],
  examples: [{ command: "lasso counter late --json", description: "late" }],
  handler: () =>
    Effect.gen(function* () {
      const progress = yield* Progress
      lateProgress = progress.report({ phase: "late", message: "after terminal" })
      return { done: true }
    }),
})

const badNextQuery = defineQuery({
  name: "counter badnext",
  summary: "Emits next actions the surface rejects",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Struct({ ok: Schema.Boolean }),
  domainErrorCodes: [],
  examples: [{ command: "lasso counter badnext --json", description: "bad next" }],
  handler: () => Effect.succeed({ ok: true }),
  next: () => [
    { message: "bogus", args: ["nonsense"] },
    { message: "valid", args: ["counter", "list", "--json"] },
    { message: "bad flag", args: ["counter", "list", "--nope"] },
  ],
})

const contracts = [
  taskList,
  badNextQuery,
  consoleLeakQuery,
  lateProgressQuery,
  counterMutation,
  failingQuery,
  listQuery,
  argsQuery,
  taskCreate,
  progressQuery,
  progressFailQuery,
  progressMutation,
  progressListQuery,
  badProgressQuery,
]

const seedTask = new Task({
  id: "task_seed",
  title: "Seed",
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
})

const invoke = (
  argv: ReadonlyArray<string>,
  format: OutputMode["format"] = "json",
  tasks: ReadonlyArray<Task> = [seedTask],
) => makeInvoke(contracts)(argv, format, tasks)

const reset = () => {
  counters.plan = 0
  counters.apply = 0
  lastPlanInput = {}
}

describe("mutation state machine", () => {
  it("no controls: plan once, apply never, confirmation once, exit 4", async () => {
    reset()
    const result = await invoke(["counter", "bump"])
    expect(result.code).toBe(4)
    expect(counters).toEqual({ plan: 1, apply: 0 })
    const [envelope] = lines(result.stdout)
    expect(envelope!.status).toBe("confirmation_required")
    expect(envelope!.confirmation.confirmArgs).toContain("--confirm")
  })

  it("--yes: plan once, apply once", async () => {
    reset()
    const result = await invoke(["counter", "bump", "--yes"])
    expect(result.code).toBe(0)
    expect(counters).toEqual({ plan: 1, apply: 1 })
  })

  it("a valid confirmation token applies; framework controls never reach plan input", async () => {
    reset()
    const first = await invoke(["counter", "bump"])
    const confirmArgs = lines(first.stdout)[0]!.confirmation.confirmArgs as Array<string>
    // The real binary strips global format flags in negotiate(); mirror that.
    const second = await invoke(confirmArgs.filter((arg) => arg !== "--json"))
    expect(second.code).toBe(0)
    expect(counters).toEqual({ plan: 2, apply: 1 })
    expect(Object.keys(lastPlanInput).toSorted()).toEqual(["value"])
  })

  it("a stale token never applies", async () => {
    reset()
    const result = await invoke(["counter", "bump", "--confirm", "plan_0000000000000000"])
    expect(result.code).toBe(64)
    expect(counters).toEqual({ plan: 1, apply: 0 })
    expect(lines(result.stdout)[0]!.error.code).toBe("stale_confirmation")
  })

  it("a token from a different plan value is stale", async () => {
    reset()
    const first = await invoke(["counter", "bump", "--value", "1"])
    const token = lines(first.stdout)[0]!.confirmation.token as string
    const second = await invoke(["counter", "bump", "--value", "2", "--confirm", token])
    expect(second.code).toBe(64)
    expect(counters.apply).toBe(0)
  })

  it("--dry-run: plan once, apply never", async () => {
    reset()
    const result = await invoke(["counter", "bump", "--dry-run"])
    expect(result.code).toBe(0)
    expect(counters).toEqual({ plan: 1, apply: 0 })
    expect(lines(result.stdout)[0]!.data.dryRun).toBe(true)
  })

  it("contradictory controls fail before planning", async () => {
    reset()
    for (const argv of [
      ["counter", "bump", "--dry-run", "--yes"],
      ["counter", "bump", "--dry-run", "--confirm", "plan_x"],
      ["counter", "bump", "--yes", "--confirm", "plan_x"],
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential protocol checks
      const result = await invoke(argv)
      expect(result.code).toBe(64)
      expect(lines(result.stdout)[0]!.error.code).toBe("invalid_usage")
    }
    expect(counters).toEqual({ plan: 0, apply: 0 })
  })
})

describe("outcome matrix — stream shapes", () => {
  it("json success: exactly one ok envelope on stdout", async () => {
    const result = await invoke(["counter", "list"])
    const envelopes = lines(result.stdout)
    expect(envelopes.length).toBe(1)
    expect(envelopes[0]!.status).toBe("ok")
    expect(result.code).toBe(0)
  })

  it("ndjson collection: item events then a summary terminal", async () => {
    const result = await invoke(["counter", "list"], "ndjson")
    const events = lines(result.stdout, "ndjson")
    expect(events.map((event) => event["event"])).toEqual(["item", "summary"])
  })

  it("ndjson empty collection still ends with summary {count: 0}", async () => {
    const result = await invoke(["counter", "list"], "ndjson", [])
    const events = lines(result.stdout, "ndjson")
    expect(events).toEqual([{ event: "summary", data: { count: 0 }, next: [], guides: [] }])
  })

  it("ndjson confirmation is a confirmation_required event", async () => {
    reset()
    const result = await invoke(["counter", "bump"], "ndjson")
    expect(result.code).toBe(4)
    const events = lines(result.stdout, "ndjson")
    expect(events.length).toBe(1)
    expect(events[0]!.event).toBe("confirmation_required")
    expect(events[0]!.confirmation.confirmArgs).toContain("ndjson")
  })

  it("expected errors keep details, fix, and transient in every machine mode", async () => {
    for (const format of ["json", "ndjson"] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential protocol checks
      const result = await invoke(["counter", "fail"], format)
      expect(result.code).toBe(65)
      const event = lines(result.stdout, format === "json" ? "json" : "ndjson")[0]!
      const error = event.error
      expect(error.details).toEqual({ field: "x" })
      expect(error.fix).toBe("send a good payload")
      expect(error.transient).toBe(false)
    }
  })

  it("text mode: data on stdout only, errors on stderr only", async () => {
    const ok = await invoke(["counter", "list"], "text")
    expect(ok.stdout.length).toBeGreaterThan(0)
    expect(ok.stderr).toBe("")

    const bad = await invoke(["counter", "fail"], "text")
    expect(bad.stdout).toBe("")
    expect(bad.stderr).toContain("error:")
    expect(bad.code).toBe(65)
  })
})

describe("projection", () => {
  it("validates fields against the static inventory even on empty collections", async () => {
    const empty = await invoke(["counter", "list", "--fields", "bogus"], "json", [])
    expect(empty.code).toBe(64)
    expect(lines(empty.stdout)[0]!.error.fix).toContain("id")

    const populated = await invoke(["counter", "list", "--fields", "bogus"])
    expect(populated.code).toBe(64)
  })

  it("projects encoded rows and preserves requested order", async () => {
    const result = await invoke(["counter", "list", "--fields", "title,id"])
    const envelope = lines(result.stdout)[0]!
    expect(Object.keys(envelope.data.items[0])).toEqual(["title", "id"])
  })

  it("rejects empty and text-mode projections", async () => {
    const empty = await invoke(["counter", "list", "--fields", " , "])
    expect(empty.code).toBe(64)

    const text = await invoke(["counter", "list", "--fields", "id"], "text")
    expect(text.code).toBe(64)
    expect(text.stderr).toContain("machine format")
  })

  it("query handlers never see the fields control", async () => {
    reset()
    await invoke(["counter", "bump", "--dry-run"])
    expect(lastPlanInput).not.toHaveProperty("fields")
    expect(lastPlanInput).not.toHaveProperty("dryRun")
  })
})

describe("parser failures settle through the kit-owned classification", () => {
  it("unknown subcommand: one invalid_usage envelope, exit 64, describe as fix", async () => {
    const result = await invoke(["nonsense"])
    expect(result.code).toBe(64)
    const envelope = lines(result.stdout)[0]!
    expect(envelope.error.code).toBe("invalid_usage")
    expect(envelope.error.fix).toContain("describe")
  })

  it("unrecognized flag and missing argument map to invalid_usage", async () => {
    const flag = await invoke(["counter", "bump", "--bogus"])
    expect(flag.code).toBe(64)
    expect(lines(flag.stdout)[0]!.error.message).toContain("--bogus")

    const missing = await invoke(["counter", "args"])
    expect(missing.code).toBe(64)
  })

  it("invalid values for typed arguments are usage errors", async () => {
    const result = await invoke(["counter", "args", "two", "low", "./x"])
    expect(result.code).toBe(64)
  })

  it("typed arguments parse and round-trip", async () => {
    const result = await invoke(["counter", "args", "2", "high", "./somewhere"])
    expect(result.code).toBe(0)
    const envelope = lines(result.stdout)[0]!
    expect(envelope.data.count).toBe(2)
    expect(envelope.data.level).toBe("high")
  })
})

describe("confirmation edge cases", () => {
  it("a failing re-plan under --confirm maps to stale_confirmation", async () => {
    // "Seed" derives id task_seed, which already exists in the fake store —
    // plan fails with resource_conflict, which --confirm reports as staleness.
    const result = await invoke(["task", "create", "Seed", "--confirm", "plan_0000000000000000"])
    expect(result.code).toBe(64)
    const envelope = lines(result.stdout)[0]!
    expect(envelope.error.code).toBe("stale_confirmation")
    expect(envelope.error.details).toEqual({ code: "resource_conflict" })
  })

  it("confirmArgs inserts controls before a -- terminator", async () => {
    reset()
    const result = await invoke(["counter", "bump", "--"])
    expect(result.code).toBe(4)
    const confirmArgs = lines(result.stdout)[0]!.confirmation.confirmArgs as Array<string>
    expect(confirmArgs.indexOf("--confirm")).toBeLessThan(confirmArgs.indexOf("--"))
  })
})

describe("progress events", () => {
  it("ndjson: nonterminal progress events precede exactly one terminal", async () => {
    const result = await invoke(["counter", "slow"], "ndjson")
    expect(result.code).toBe(0)
    const events = lines(result.stdout, "ndjson")
    expect(events.map((event) => event["event"])).toEqual(["progress", "progress", "summary"])
    expect(events[1]).toEqual({
      event: "progress",
      phase: "main",
      message: "working",
      completed: 2,
      total: 4,
    })
  })

  it("json: stdout stays exactly one envelope; progress goes to stderr", async () => {
    const result = await invoke(["counter", "slow"], "json")
    expect(result.code).toBe(0)
    const envelopes = lines(result.stdout)
    expect(envelopes.length).toBe(1)
    expect(result.stderr).toContain("progress[main]: working (2/4)")
  })

  it("text: progress lines on stderr, data on stdout", async () => {
    const result = await invoke(["counter", "slow"], "text")
    expect(result.stderr).toContain("progress[warm-up]: starting")
    expect(result.stdout).not.toContain("progress")
  })
})

describe("progress across the outcome matrix", () => {
  it("progress precedes an expected error terminal in ndjson", async () => {
    const result = await invoke(["counter", "slowfail"], "ndjson")
    expect(result.code).toBe(65)
    const events = lines(result.stdout, "ndjson")
    expect(events.map((event) => event["event"])).toEqual(["progress", "error"])
  })

  it("progress precedes a confirmation_required terminal in ndjson", async () => {
    const result = await invoke(["counter", "slowbump"], "ndjson")
    expect(result.code).toBe(4)
    const events = lines(result.stdout, "ndjson")
    expect(events.map((event) => event["event"])).toEqual(["progress", "confirmation_required"])
  })

  it("progress precedes collection items; the stream still ends in summary", async () => {
    const result = await invoke(["counter", "slowlist"], "ndjson")
    const events = lines(result.stdout, "ndjson")
    expect(events.map((event) => event["event"])).toEqual(["progress", "item", "summary"])
  })

  it("invalid counters become one internal_error with exit 70", async () => {
    const result = await invoke(["counter", "badprogress"])
    expect(result.code).toBe(70)
    const envelopes = lines(result.stdout)
    expect(envelopes.length).toBe(1)
    expect(envelopes[0]!.error.code).toBe("internal_error")
  })
})

describe("stdout purity against handler misbehavior", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("every Console method a handler can call lands on stderr, never in the envelope stream", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const result = await invoke(["counter", "leak"])
    expect(result.code).toBe(0)
    expect(lines(result.stdout).length).toBe(1)
    expect(lines(result.stdout)[0]!.status).toBe("ok")
    expect(stdoutWrite).not.toHaveBeenCalled()
    const leaked = stderrWrite.mock.calls.map((call) => String(call[0])).join("")
    expect(leaked.split("debug leak").length - 1).toBe(4)
    expect(leaked).toContain("leak")
  })

  it("Console output in ndjson mode leaves the event stream valid", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const result = await invoke(["counter", "leak"], "ndjson")
    expect(result.code).toBe(0)
    expect(lines(result.stdout, "ndjson").map((event) => event.event)).toEqual(["summary"])
  })

  it("a progress effect run after the terminal event is a defect, not a write", async () => {
    lateProgress = undefined
    const result = await invoke(["counter", "late"], "ndjson")
    expect(lines(result.stdout, "ndjson").map((event) => event.event)).toEqual(["summary"])
    expect(lateProgress).toBeDefined()
    const exit = await Effect.runPromiseExit(lateProgress!)
    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("progress after the terminal event")
  })
})

describe("point-of-use guidance on the wire", () => {
  it("every terminal envelope carries next and guides", async () => {
    const ok = lines((await invoke(["counter", "list"])).stdout)[0]!
    expect(ok.next).toEqual([])
    expect(ok.guides).toEqual([])
    reset()
    const confirmation = lines((await invoke(["counter", "bump"])).stdout)[0]!
    expect(confirmation.next).toEqual([
      { message: "apply exactly this plan", args: confirmation.confirmation.confirmArgs },
    ])
    const failure = lines((await invoke(["counter", "fail"])).stdout)[0]!
    expect(failure.next).toEqual([])
    expect(failure.guides).toEqual([])
  })

  it("task create offers its guides on failure and a next move on success", async () => {
    const conflict = lines((await invoke(["task", "create", "Seed", "--yes"])).stdout)[0]!
    expect(conflict.error.code).toBe("resource_conflict")
    expect(conflict.guides).toEqual(["task-ids", "mutation-replay"])
    const created = lines((await invoke(["task", "create", "Fresh", "--yes"])).stdout)[0]!
    expect(created.status).toBe("ok")
    expect(created.next).toEqual([
      {
        message: "see the new task in the list",
        args: ["task", "list", "--status", "all", "--json"],
      },
    ])
    expect(created.guides).toEqual([])
    expect(created.warnings).toEqual([])
  })

  it("dry run points at the confirmation flow, never at --yes", async () => {
    const result = lines((await invoke(["task", "create", "Fresh", "--dry-run"])).stdout)[0]!
    expect(result.next).toEqual([
      {
        message: "re-run without --dry-run to get a confirmation token",
        args: ["task", "create", "Fresh", "--json"],
      },
    ])
  })

  it("runtime-owned next actions keep the machine flag before a -- terminator", async () => {
    const result = lines(
      (await invoke(["task", "create", "--dry-run", "--", "--weird"])).stdout,
    )[0]!
    expect(result.warnings).toEqual([])
    expect(result.next).toEqual([
      {
        message: "re-run without --dry-run to get a confirmation token",
        args: ["task", "create", "--json", "--", "--weird"],
      },
    ])
  })

  it("a stale token points at a fresh plan without --confirm", async () => {
    const result = lines(
      (await invoke(["task", "create", "Fresh", "--confirm", "plan_0000000000000000"])).stdout,
    )[0]!
    expect(result.error.code).toBe("stale_confirmation")
    expect(result.next).toEqual([
      { message: "re-plan against the current state", args: ["task", "create", "Fresh", "--json"] },
    ])
  })

  it("an invalid next action is dropped into warnings, never a failure", async () => {
    const result = lines((await invoke(["counter", "badnext"])).stdout)[0]!
    expect(result.status).toBe("ok")
    expect(result.next).toEqual([{ message: "valid", args: ["counter", "list", "--json"] }])
    expect(result.warnings).toEqual([
      'dropped next action "bogus": "nonsense" is not a command',
      'dropped next action "bad flag": flag --nope is not declared for "counter list"',
    ])
  })

  it("ndjson terminal events carry next and guides too", async () => {
    const events = lines(
      (await invoke(["task", "create", "Fresh", "--yes"], "ndjson")).stdout,
      "ndjson",
    )
    const summary = events.at(-1)!
    expect(summary.event).toBe("summary")
    expect(summary.guides).toEqual([])
    expect(summary.next.length).toBe(1)
    const conflict = lines(
      (await invoke(["task", "create", "Seed", "--yes"], "ndjson")).stdout,
      "ndjson",
    )
    expect(conflict.at(-1)!.guides).toEqual(["task-ids", "mutation-replay"])
  })

  it("text mode renders next: and guide: lines with fixed prefixes", async () => {
    const result = await invoke(["task", "create", "Fresh", "--yes"], "text")
    expect(result.stdout).toContain(
      "next: see the new task in the list: lasso task list --status all --json",
    )
    const conflict = await invoke(["task", "create", "Seed", "--yes"], "text")
    expect(conflict.stderr).toContain("guide: lasso guide get task-ids")
    expect(conflict.stderr).toContain(
      "next: see the existing task: lasso task list --status all --json",
    )
  })
})
