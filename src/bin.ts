import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { Exit } from "effect"
import { buildRoot, machineOutputLayer, runRoot } from "./contract/adapter.ts"
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

/**
 * The process boundary: the only module that touches `process`, and the only
 * place `Effect.run*` appears. All outcome classification lives in
 * `runtime.ts` (shared with the in-process runtime tests); this file just
 * connects it to the real stdout, stderr, and exit code.
 */

const write = (writes: ReadonlyArray<Write>): void => {
  for (const chunk of writes) {
    if (chunk.stream === "stdout") {
      process.stdout.write(chunk.text)
    } else {
      process.stderr.write(chunk.text)
    }
  }
}

const render = (mode: OutputMode, outcome: Outcome): void =>
  write(renderOutcome(mode, CLI_NAME, outcome))

const describeData = () => describeCli({ binName: CLI_NAME, version: CLI_VERSION, contracts })

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
        fix: "use --format auto|json|text|ndjson",
        transient: false,
      })
      return ExitCode.usage
    }
    throw error
  }

  // Explicit help in a machine format answers with `describe` data directly:
  // agents should never have to parse help text. (Text-mode help is rendered
  // by the parser runtime.)
  if (mode.format !== "text" && mode.helpRequested) {
    render(mode, { kind: "ok", data: describeData() })
    return ExitCode.success
  }

  const root = buildRoot(CLI_NAME, CLI_SUMMARY, contracts)
  const baseLayer = Layer.mergeAll(appServicesLayer, Renderer.layer(mode, CLI_NAME))
  const appLayer = (
    mode.format === "text" ? baseLayer : Layer.mergeAll(baseLayer, machineOutputLayer)
  ).pipe(Layer.provideMerge(NodeServices.layer))

  const program = runRoot(root, CLI_VERSION, mode.argv).pipe(Effect.provide(appLayer))
  const exit: Exit.Exit<void, unknown> = await Effect.runPromiseExit(program)

  const settled = settleExit({ exit, mode, binName: CLI_NAME, describeData })
  write(settled.writes)
  return settled.code
}

process.on("SIGINT", () => {
  // Never write to stdout on interrupt — machine output must stay parseable.
  process.exit(ExitCode.interrupted)
})

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = ExitCode.internalDefect
  },
)
