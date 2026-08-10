import { Effect, FileSystem, Layer, Path, Schema, Sink, Stdio, Terminal } from "effect"
import type { Exit } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect, it } from "vitest"
import { buildRoot, runRoot } from "../../src/contract/adapter.ts"
import {
  ConfirmationEnvelope,
  ErrorEnvelope,
  OkEnvelope,
  StreamEvent,
} from "../../src/output/envelope.ts"
import { defineMutation, defineQuery } from "../../src/contract/contract.ts"
import type { OutputMode } from "../../src/output/format.ts"
import { Renderer } from "../../src/output/renderer.ts"
import { settleExit } from "../../src/runtime.ts"
import { Progress } from "../../src/output/progress.ts"
import { StoreReader, StoreWriter } from "../../src/services/store.ts"
import { Task } from "../../src/domain/task.ts"
import { taskCreate } from "../../src/commands/task-create.ts"

/**
 * The outcome matrix: the ENTIRE runtime — parser, contract adapter,
 * renderer, exit settlement — run in-process against test layers. This is
 * where the mutation state machine and stream-shape guarantees are proven,
 * without ever spawning the binary.
 */

const collect = (into: Array<string>) =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    }),
  )

interface Invocation {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

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
      return yield* Errors.invalidData({ message: "went bad after progress" })
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

const contracts = [
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

const invoke = async (
  argv: ReadonlyArray<string>,
  format: OutputMode["format"] = "json",
  tasks: ReadonlyArray<Task> = [seedTask],
): Promise<Invocation> => {
  const mode: OutputMode = {
    format,
    noInput: true,
    color: false,
    argv,
    helpRequested: false,
    explicitFormat: true,
  }
  const out: Array<string> = []
  const err: Array<string> = []

  const testStdio = Stdio.layerTest({
    stdout: () => collect(out),
    stderr: () => collect(err),
  })

  const fakeServices = Layer.mergeAll(
    Layer.succeed(StoreReader, StoreReader.of({ load: Effect.succeed(tasks) })),
    Layer.succeed(
      StoreWriter,
      StoreWriter.of({ modify: (transform) => Effect.sync(() => transform(tasks) ?? tasks) }),
    ),
  )

  const environment = Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    testStdio,
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readInput: Effect.die("no input in tests"),
        readLine: Effect.die("no input in tests"),
        display: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("no processes in tests")),
    ),
  )

  const root = buildRoot("lasso", "test cli", contracts)
  const rendererLayer = Renderer.layer(mode, "lasso")
  const layer = Layer.mergeAll(
    fakeServices,
    rendererLayer,
    Progress.layer.pipe(Layer.provideMerge(rendererLayer)),
  ).pipe(Layer.provideMerge(environment))
  const exit: Exit.Exit<void, unknown> = await Effect.runPromiseExit(
    runRoot(root, "0.0.0", argv).pipe(Effect.provide(layer)),
  )
  const settled = settleExit({ exit, mode, binName: "lasso", describeData: () => ({}) })
  for (const chunk of settled.writes) {
    ;(chunk.stream === "stdout" ? out : err).push(chunk.text)
  }
  return { stdout: out.join(""), stderr: err.join(""), code: settled.code }
}

const AnyEnvelope = Schema.Union([OkEnvelope, ErrorEnvelope, ConfirmationEnvelope])
const decodeEnvelope = Schema.decodeUnknownSync(AnyEnvelope)
const decodeEvent = Schema.decodeUnknownSync(StreamEvent)

/**
 * Every stdout line is validated against the declared protocol schemas as it
 * is read — the envelope schemas are the executable spec, not documentation.
 */
const lines = (text: string, wire: "json" | "ndjson" = "json"): Array<Record<string, any>> =>
  text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = JSON.parse(line) as Record<string, any>
      if (wire === "json") {
        decodeEnvelope(value)
      } else {
        decodeEvent(value)
      }
      return value
    })

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
    expect(events).toEqual([{ event: "summary", data: { count: 0 } }])
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
