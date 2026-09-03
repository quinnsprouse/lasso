import { Effect, FileSystem, Layer, Path, Schema, Sink, Stdio, Terminal } from "effect"
import type { Exit } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { buildRoot, machineOutputLayer, runRoot } from "../../src/contract/adapter.ts"
import type { AnyContract } from "../../src/contract/contract.ts"
import { surfaceOf } from "../../src/contract/surface.ts"
import type { Task } from "../../src/domain/task.ts"
import {
  ConfirmationEnvelope,
  ErrorEnvelope,
  OkEnvelope,
  StreamEvent,
} from "../../src/output/envelope.ts"
import type { OutputMode } from "../../src/output/format.ts"
import { Progress } from "../../src/output/progress.ts"
import { Renderer } from "../../src/output/renderer.ts"
import { settleExit } from "../../src/runtime.ts"
import { StoreReader, StoreWriter } from "../../src/services/store.ts"

/**
 * The in-process harness: the ENTIRE runtime — parser, contract adapter,
 * renderer, exit settlement — run against test layers, never the binary.
 * Contract suites build one `invoke` per roster; every stdout line they read
 * is validated against the declared protocol schemas as it is parsed.
 */

export interface Invocation {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

const collect = (into: Array<string>) =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    }),
  )

export const makeInvoke =
  (contracts: ReadonlyArray<AnyContract>) =>
  async (
    argv: ReadonlyArray<string>,
    format: OutputMode["format"] = "json",
    tasks: ReadonlyArray<Task> = [],
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
    // Machine formats get the same Console/formatter shim bin.ts installs.
    const outputShim = format === "text" ? Layer.empty : machineOutputLayer(format)
    const layer = Layer.mergeAll(
      fakeServices,
      rendererLayer,
      Progress.layer.pipe(Layer.provideMerge(rendererLayer)),
      outputShim,
    ).pipe(Layer.provideMerge(environment))
    const exit: Exit.Exit<void, unknown> = await Effect.runPromiseExit(
      runRoot(root, "0.0.0", argv).pipe(Effect.provide(layer)),
    )
    const settled = settleExit({
      exit,
      mode,
      binName: "lasso",
      describeData: () => ({}),
      surfaces: contracts.map(surfaceOf),
    })
    for (const chunk of settled.writes) {
      ;(chunk.stream === "stdout" ? out : err).push(chunk.text)
    }
    return { stdout: out.join(""), stderr: err.join(""), code: settled.code }
  }

const AnyEnvelope = Schema.Union([OkEnvelope, ErrorEnvelope, ConfirmationEnvelope])
const decodeEnvelope = Schema.decodeUnknownSync(AnyEnvelope)
const decodeEvent = Schema.decodeUnknownSync(StreamEvent)

/** Every stdout line, validated against the protocol schemas as it is read. */
export const lines = (text: string, wire: "json" | "ndjson" = "json"): Array<Record<string, any>> =>
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
