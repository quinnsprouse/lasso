import { Effect } from "effect"
import type { Exit } from "effect"
import { describe, expect, it } from "vitest"
import { ExitSignal } from "../../src/contract/adapter.ts"
import { AppError, Errors } from "../../src/errors.ts"
import type { OutputMode } from "../../src/output/format.ts"
import { settleExit } from "../../src/runtime.ts"

/**
 * Exit settlement covers every terminal class: success, control-flow exits,
 * expected failures, interruption, EPIPE, and defects — asserted per format.
 */

const mode = (format: OutputMode["format"]): OutputMode => ({
  format,
  noInput: true,
  color: false,
  argv: [],
  helpRequested: false,
  explicitFormat: true,
})

const exitOf = (effect: Effect.Effect<void, unknown>): Promise<Exit.Exit<void, unknown>> =>
  Effect.runPromiseExit(effect)

const settle = async (effect: Effect.Effect<void, unknown>, format: OutputMode["format"]) =>
  settleExit({
    exit: await exitOf(effect),
    mode: mode(format),
    binName: "lasso",
    describeData: () => ({ marker: true }),
    surfaces: [],
  })

describe("settleExit", () => {
  it("success writes nothing and exits 0", async () => {
    const settled = await settle(Effect.void, "json")
    expect(settled).toEqual({ writes: [], code: 0 })
  })

  it("ExitSignal carries its code with no writes", async () => {
    const settled = await settle(Effect.fail(new ExitSignal({ code: 4 })), "json")
    expect(settled).toEqual({ writes: [], code: 4 })
  })

  it("AppError renders one envelope with details and maps its exit", async () => {
    const settled = await settle(
      Effect.fail(Errors.transientFailure({ message: "busy", fix: "retry", details: { n: 1 } })),
      "json",
    )
    expect(settled.code).toBe(75)
    expect(settled.writes.length).toBe(1)
    const envelope = JSON.parse(settled.writes[0]!.text)
    expect(envelope.error.transient).toBe(true)
    expect(envelope.error.details).toEqual({ n: 1 })
  })

  it("AppError in text mode goes to stderr only", async () => {
    const settled = await settle(
      Effect.fail(Errors.authFailure({ message: "no token", fix: "log in" })),
      "text",
    )
    expect(settled.code).toBe(77)
    expect(settled.writes.every((write) => write.stream === "stderr")).toBe(true)
  })

  it("interruption exits 130 with a terminal interrupted envelope", async () => {
    const settled = await settle(Effect.interrupt, "json")
    expect(settled.code).toBe(130)
    expect(settled.writes.length).toBe(1)
    const envelope = JSON.parse(settled.writes[0]!.text)
    expect(envelope.status).toBe("error")
    expect(envelope.error.code).toBe("interrupted")
    expect(envelope.error.transient).toBe(true)
  })

  it("interruption in ndjson mode ends the stream with an error event", async () => {
    const settled = await settle(Effect.interrupt, "ndjson")
    expect(settled.code).toBe(130)
    const event = JSON.parse(settled.writes.at(-1)!.text)
    expect(event.event).toBe("error")
    expect(event.error.code).toBe("interrupted")
    expect(event.next).toEqual([])
  })

  it("EPIPE defects exit 0 with no further output", async () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
    const settled = await settle(Effect.die(epipe), "json")
    expect(settled).toEqual({ writes: [], code: 0 })
  })

  it("EPIPE nested inside a platform error cause still exits 0 silently", async () => {
    // The Stdio service wraps the native error: { _tag, reason, cause: { code: "EPIPE" } }.
    const native = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
    const wrapped = Object.assign(new Error("SystemError: write failed"), {
      _tag: "PlatformError",
      reason: { _tag: "Unknown" },
      cause: native,
    })
    const settled = await settle(Effect.die(wrapped), "json")
    expect(settled).toEqual({ writes: [], code: 0 })
  })

  it("other defects render internal_error once and exit 70", async () => {
    const settled = await settle(Effect.die(new Error("boom")), "json")
    expect(settled.code).toBe(70)
    const envelope = JSON.parse(settled.writes[0]!.text)
    expect(envelope.error.code).toBe("internal_error")
    expect(envelope.error.transient).toBe(false)
  })

  it("defects in ndjson mode are error events", async () => {
    const settled = await settle(Effect.die(new Error("boom")), "ndjson")
    const event = JSON.parse(settled.writes[0]!.text)
    expect(event.event).toBe("error")
  })
})

describe("an interrupted command", () => {
  it("inherits the command's guides and offers a re-plan", async () => {
    const { contracts } = await import("../../src/commands/index.ts")
    const { surfaceOf } = await import("../../src/contract/surface.ts")
    const exit = await Effect.runPromiseExit(Effect.interrupt)
    const settled = settleExit({
      exit,
      mode: { ...mode("json"), argv: ["task", "create", "x", "--yes"] },
      binName: "lasso",
      describeData: () => ({}),
      surfaces: contracts.map(surfaceOf),
    })
    const envelope = JSON.parse(settled.writes.at(-1)!.text)
    expect(envelope.guides).toEqual(["task-ids", "mutation-replay"])
    expect(envelope.next).toEqual([
      {
        message: "re-run and re-plan against the current state",
        args: ["task", "create", "x", "--json"],
      },
    ])
  })
})

describe("settleExit derives exit and transience from the catalog", () => {
  it("an AppError built by hand with a bogus exit still maps through the catalog", async () => {
    const forged = new AppError({
      code: "invalid_usage",
      message: "hand built",
      fix: "none",
      transient: true,
      exit: 99,
    })
    const settled = await settle(Effect.fail(forged), "json")
    expect(settled.code).toBe(64)
    expect(JSON.parse(settled.writes[0]!.text).error.transient).toBe(false)
  })

  it("an inherited-key code such as toString is not a catalog hit", async () => {
    const forged = new AppError({
      code: "toString",
      message: "hand built",
      fix: "none",
      transient: false,
      exit: 0,
    })
    const settled = await settle(Effect.fail(forged), "json")
    expect(settled.code).toBe(70)
    expect(JSON.parse(settled.writes[0]!.text).error.code).toBe("internal_error")
  })

  it("an AppError with a code outside the catalog is an internal_error defect", async () => {
    const forged = new AppError({
      code: "not_in_catalog",
      message: "hand built",
      fix: "none",
      transient: false,
      exit: 0,
    })
    const settled = await settle(Effect.fail(forged), "json")
    expect(settled.code).toBe(70)
    const envelope = JSON.parse(settled.writes[0]!.text)
    expect(envelope.error.code).toBe("internal_error")
    expect(envelope.error.message).toContain("not_in_catalog")
  })
})
