import { NodeServices } from "@effect/platform-node"
import { Effect, Exit, Fiber, Layer } from "effect"
import { outputLayer, runCli } from "./contract/adapter.ts"
import { surfaceOf } from "./contract/surface.ts"
import { describeCli } from "./contract/jsonschema.ts"
import { ExitCode } from "./output/exit.ts"
import { FormatNegotiationError, negotiate } from "./output/format.ts"
import { DISCOVER } from "./output/guidance.ts"
import type { OutputMode } from "./output/format.ts"
import type { Outcome, Write } from "./output/outcome.ts"
import { renderOutcome } from "./output/outcome.ts"
import { Renderer, TerminalLatch } from "./output/renderer.ts"
import { settleExit } from "./runtime.ts"
import { appServicesLayer } from "./services/index.ts"
import { CLI_NAME, CLI_SUMMARY, CLI_VERSION } from "./meta.ts"
import { contracts } from "./commands/index.ts"

// Process boundary: argv, signals, effect execution, settled writes, and exit status.

// A consumer that stops reading (`| head`) closes our stdout. That is not an
// error: the run settles as success with nothing more to say. Without this
// listener Node raises an unhandled 'error' event and exits 1 with a stack.
let stdoutClosed = false
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    stdoutClosed = true
    return
  }
  throw error
})

const write = (writes: ReadonlyArray<Write>): void => {
  for (const chunk of writes) {
    if (chunk.stream === "stdout") {
      if (!stdoutClosed) {
        process.stdout.write(chunk.text)
      }
    } else {
      process.stderr.write(chunk.text)
    }
  }
}

const render = (mode: OutputMode, outcome: Outcome): void =>
  write(renderOutcome(mode, CLI_NAME, outcome))

const describeData = () => describeCli({ binName: CLI_NAME, version: CLI_VERSION, contracts })
const surfaces = contracts.map(surfaceOf)

const main = async (): Promise<number> => {
  let mode: OutputMode
  try {
    mode = negotiate({
      argv: process.argv.slice(2),
      stdoutIsTTY: process.stdout.isTTY,
      stdinIsTTY: process.stdin.isTTY,
      env: process.env,
    })
  } catch (error) {
    if (error instanceof FormatNegotiationError) {
      render(error.mode, {
        kind: "failure",
        code: "invalid_usage",
        message: error.message,
        fix: error.fix,
        transient: false,
        next: [DISCOVER],
      })
      return ExitCode.usage
    }
    throw error
  }

  const terminal = new TerminalLatch()
  const appLayer = outputLayer(mode).pipe(
    Layer.provideMerge(appServicesLayer),
    Layer.provideMerge(Renderer.layer(mode, CLI_NAME, terminal)),
    Layer.provideMerge(NodeServices.layer),
  )
  const program = runCli({
    binName: CLI_NAME,
    summary: CLI_SUMMARY,
    version: CLI_VERSION,
    contracts,
  }).pipe(Effect.provide(appLayer))

  // SIGINT (Ctrl-C) and SIGTERM (what agent harnesses and CI send on a
  // timeout) interrupt the fiber so Effect finalizers, like the store lock
  // release, run before exit; the run settles as `interrupted`. A second
  // signal means the caller stopped waiting for cleanup.
  const fiber = Effect.runFork(program)
  let signalled = false
  const onSignal = () => {
    if (signalled) {
      process.exit(ExitCode.interrupted)
    }
    signalled = true
    Effect.runFork(Fiber.interrupt(fiber))
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  // When every fiber waits on something nothing can complete, Node's event
  // loop drains and the process would exit 0 with no output. Interrupt like a
  // signal, so finalizers run, then settle as the defect it is. Should the
  // interrupt never finish either, the process still exits 70.
  let stalled = false
  const onStall = () => {
    stalled = true
    process.exitCode = ExitCode.internalDefect
    Effect.runFork(Fiber.interrupt(fiber))
  }
  process.once("beforeExit", onStall)
  const finished = await Effect.runPromise(Fiber.await(fiber))
  process.removeListener("beforeExit", onStall)
  const exit = stalled
    ? Exit.die(
        new Error("the command stopped making progress: it waits on work that can never finish"),
      )
    : finished

  const settled = await Effect.runPromise(
    settleExit({
      exit,
      mode,
      binName: CLI_NAME,
      describeData,
      surfaces,
      written: terminal.code,
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  write(settled.writes)
  return settled.code
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = ExitCode.internalDefect
  },
)
