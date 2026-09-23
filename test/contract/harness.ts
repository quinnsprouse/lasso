import { Writable } from "node:stream"
import { Effect, FileSystem, Layer, Path, Schema, Sink, Stdio, Terminal } from "effect"
import type { Exit } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { outputLayer, runCli } from "../../src/contract/adapter.ts"
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
import { negotiate } from "../../src/output/format.ts"
import { Progress } from "../../src/output/progress.ts"
import { Renderer, TerminalLatch } from "../../src/output/renderer.ts"
import { settleExit } from "../../src/runtime.ts"
import { TaskFeed } from "../../src/services/feed.ts"
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

/** What the parser needs from the platform, with no terminal input, processes, or files. */
export const testPlatform = (stdio: Layer.Layer<Stdio.Stdio>) =>
  Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    stdio,
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

/** A stream whose writes append to `into`: stands in for stdout or stderr. */
const sink = (into: Array<string>) =>
  new Writable({
    write(chunk, _encoding, done) {
      into.push(String(chunk))
      done()
    },
  })

export const makeInvoke =
  (contracts: ReadonlyArray<AnyContract>) =>
  async (
    argv: ReadonlyArray<string>,
    format: OutputMode["format"] = "json",
    tasks: ReadonlyArray<Task> = [],
    /** The titles the fake task feed serves at any URL. */
    feed: ReadonlyArray<string> = [],
  ): Promise<Invocation> => {
    const mode = negotiate({
      argv,
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: { LASSO_FORMAT: format },
    })
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
        StoreWriter.of({ modify: (transform) => Effect.sync(() => transform(tasks).result) }),
      ),
      Layer.succeed(TaskFeed, TaskFeed.of({ titles: () => Effect.succeed(feed) })),
    )

    const environment = testPlatform(testStdio)

    // Console output (help, parser diagnostics, stray handler logging) lands in
    // this invocation's streams, exactly where bin.ts would send it.
    const terminal = new TerminalLatch()
    const layer = outputLayer(mode, { stdout: sink(out), stderr: sink(err) }).pipe(
      Layer.provideMerge(Layer.mergeAll(fakeServices, Progress.layer)),
      Layer.provideMerge(Renderer.layer(mode, "lasso", terminal)),
      Layer.provideMerge(environment),
    )
    const exit: Exit.Exit<void, unknown> = await Effect.runPromiseExit(
      runCli({ binName: "lasso", summary: "test cli", version: "0.0.0", contracts }).pipe(
        Effect.provide(layer),
      ),
    )
    const settled = await Effect.runPromise(
      settleExit({
        exit,
        mode,
        binName: "lasso",
        describeData: () => ({}),
        surfaces: contracts.map(surfaceOf),
        written: terminal.code,
      }).pipe(Effect.provide(environment)),
    )
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

/**
 * A documented `<bin> …` line as argv: placeholders are filled (`<token>` with
 * a token-shaped value, anything else with `x`) and quoted spans stay one token.
 */
export const argvOf = (line: string): ReadonlyArray<string> =>
  line
    .replace(/<token>/g, "plan_0000000000000000")
    .replace(/<[^>]+>/g, "x")
    .match(/"[^"]*"|\S+/g)!
    .slice(1)
    .map((token) => token.replace(/^"|"$/g, ""))
