import { Effect } from "effect"
import type { Exit } from "effect"
import { describe, expect, it } from "vitest"
import { ExitSignal } from "../../src/contract/adapter.ts"
import { Errors } from "../../src/errors.ts"
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
})

const exitOf = (effect: Effect.Effect<void, unknown>): Promise<Exit.Exit<void, unknown>> =>
  Effect.runPromiseExit(effect)

const settle = async (effect: Effect.Effect<void, unknown>, format: OutputMode["format"]) =>
  settleExit({
    exit: await exitOf(effect),
    mode: mode(format),
    binName: "lasso",
    describeData: () => ({ marker: true }),
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
      Effect.fail(Errors.transient({ message: "busy", fix: "retry", details: { n: 1 } })),
      "json",
    )
    expect(settled.code).toBe(75)
    expect(settled.writes.length).toBe(1)
    const envelope = JSON.parse(settled.writes[0]!.text)
    expect(envelope.error.transient).toBe(true)
    expect(envelope.error.details).toEqual({ n: 1 })
  })

  it("AppError in text mode goes to stderr only", async () => {
    const settled = await settle(Effect.fail(Errors.auth({ message: "no token" })), "text")
    expect(settled.code).toBe(77)
    expect(settled.writes.every((write) => write.stream === "stderr")).toBe(true)
  })

  it("interruption exits 130 silently", async () => {
    const settled = await settle(Effect.interrupt, "json")
    expect(settled).toEqual({ writes: [], code: 130 })
  })

  it("EPIPE defects exit 0 with no further output", async () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
    const settled = await settle(Effect.die(epipe), "json")
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
