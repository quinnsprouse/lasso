import { Effect, Layer, Sink, Stdio } from "effect"
import { describe, expect, it } from "vitest"
import type { OutputMode } from "../../src/output/format.ts"
import { Renderer } from "../../src/output/renderer.ts"
import { testPlatform } from "../contract/harness.ts"

/**
 * The terminal latch: once an outcome is emitted, any further output through
 * the Renderer is a defect — a detached fiber can never write past the
 * terminal event.
 */

const mode: OutputMode = {
  format: "ndjson",
  noInput: true,
  color: false,
  argv: [],
  helpRequested: false,
  explicitFormat: true,
}

const withRenderer = <A>(
  body: (renderer: Renderer["Service"]) => Effect.Effect<A, unknown>,
  stdio: Partial<Stdio.Stdio> = {},
): Promise<A> => {
  const environment = testPlatform(Stdio.layerTest(stdio))
  return Effect.runPromise(
    Effect.gen(function* () {
      const renderer = yield* Renderer
      return yield* body(renderer)
    }).pipe(
      Effect.provide(Renderer.layer(mode, "lasso").pipe(Layer.provideMerge(environment))),
    ) as Effect.Effect<A>,
  )
}

describe("a closed stdout", () => {
  // The Stdio service wraps the native error: { _tag, reason, cause: { code: "EPIPE" } }.
  const native = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
  const wrapped = Object.assign(new Error("SystemError: write failed"), {
    _tag: "PlatformError",
    reason: { _tag: "Unknown" },
    cause: native,
  })

  it.each([native, wrapped])("ends writing without failing (%s)", async (error) => {
    const exit = await withRenderer(
      (renderer) => Effect.exit(renderer.emit({ kind: "ok", data: {} })),
      { stdout: () => Sink.fail(error) as never },
    )
    expect(exit._tag).toBe("Success")
  })

  it("any other write failure is still a defect", async () => {
    const exit = await withRenderer(
      (renderer) => Effect.exit(renderer.emit({ kind: "ok", data: {} })),
      { stdout: () => Sink.fail(new Error("disk full")) as never },
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("renderer terminal latch", () => {
  it("progress after emit is a defect", async () => {
    const exit = await withRenderer((renderer) =>
      Effect.gen(function* () {
        yield* renderer.emit({ kind: "ok", data: { done: true } })
        return yield* Effect.exit(renderer.progress({ phase: "late", message: "too late" }))
      }),
    )
    expect(String(exit)).toContain("progress after the terminal event")
  })

  it("a second emit is a defect", async () => {
    const exit = await withRenderer((renderer) =>
      Effect.gen(function* () {
        yield* renderer.emit({ kind: "ok", data: {} })
        return yield* Effect.exit(renderer.emit({ kind: "ok", data: {} }))
      }),
    )
    expect(String(exit)).toContain("emit after the terminal event")
  })

  it("invalid progress payloads are defects via the shared schema", async () => {
    for (const bad of [
      { phase: "Bad Phase", message: "x" },
      { phase: "ok", message: "" },
      { phase: "ok", message: "x", completed: 3 },
      { phase: "ok", message: "x", completed: 5, total: 4 },
      { phase: "ok", message: "x", completed: 0, total: 0 },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential validation probes
      const exit = await withRenderer((renderer) => Effect.exit(renderer.progress(bad)))
      expect(String(exit), JSON.stringify(bad)).toContain("Die")
    }
  })
})
