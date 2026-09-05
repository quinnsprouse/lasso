import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, Layer } from "effect"
import type { Exit } from "effect"
import { machineOutputLayer, runCli } from "./contract/adapter.ts"
import { surfaceOf } from "./contract/surface.ts"
import { describeCli } from "./contract/jsonschema.ts"
import { ExitCode } from "./output/exit.ts"
import { FormatNegotiationError, negotiate } from "./output/format.ts"
import type { OutputMode } from "./output/format.ts"
import type { Outcome, Write } from "./output/outcome.ts"
import { renderOutcome } from "./output/outcome.ts"
import { Renderer } from "./output/renderer.ts"
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
        next: [{ message: "list every command and flag", args: ["describe", "--json"] }],
      })
      return ExitCode.usage
    }
    throw error
  }

  const baseLayer = appServicesLayer.pipe(Layer.provideMerge(Renderer.layer(mode, CLI_NAME)))
  const appLayer = (
    mode.format === "text" ? baseLayer : machineOutputLayer.pipe(Layer.provideMerge(baseLayer))
  ).pipe(Layer.provideMerge(NodeServices.layer))
  const program = runCli({
    binName: CLI_NAME,
    summary: CLI_SUMMARY,
    version: CLI_VERSION,
    contracts,
  }).pipe(Effect.provide(appLayer))

  // SIGINT interrupts the fiber so Effect finalizers (like the store lock
  // release) run before the process exits — and writes nothing to stdout.
  const fiber = Effect.runFork(program)
  process.on("SIGINT", () => {
    Effect.runFork(Fiber.interrupt(fiber))
  })
  const exit: Exit.Exit<void, unknown> = await Effect.runPromise(Fiber.await(fiber))

  const settled = await Effect.runPromise(
    settleExit({ exit, mode, binName: CLI_NAME, describeData, surfaces }).pipe(
      Effect.provide(NodeServices.layer),
    ),
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
