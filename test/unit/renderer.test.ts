import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect, it } from "vitest"
import type { OutputMode } from "../../src/output/format.ts"
import { Renderer } from "../../src/output/renderer.ts"

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
): Promise<A> => {
  const environment = Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({}),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readInput: Effect.die("unused"),
        readLine: Effect.die("unused"),
        display: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("unused")),
    ),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const renderer = yield* Renderer
      return yield* body(renderer)
    }).pipe(
      Effect.provide(Renderer.layer(mode, "lasso").pipe(Layer.provideMerge(environment))),
    ) as Effect.Effect<A>,
  )
}

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
