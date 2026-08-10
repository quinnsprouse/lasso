import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, Layer } from "effect"
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

  // Interactive/raw built-ins never run in machine formats: the wizard is a
  // prompt loop and completions emit a raw shell script — both would corrupt
  // the envelope protocol. The wizard is also refused when input is closed.
  const usage = (message: string, fix: string): number => {
    render(mode, { kind: "failure", code: "invalid_usage", message, fix, transient: false })
    return ExitCode.usage
  }
  const preTerminator = mode.argv.slice(
    0,
    mode.argv.includes("--") ? mode.argv.indexOf("--") : mode.argv.length,
  )
  if (preTerminator.includes("--wizard") && (mode.format !== "text" || mode.noInput)) {
    return usage(
      "--wizard is interactive and only available in text mode on a terminal",
      "run without --wizard; use describe --json for machine-readable discovery",
    )
  }
  if (preTerminator.includes("--completions")) {
    if (mode.explicitFormat && mode.format !== "text") {
      return usage(
        "--completions emits a raw shell script, not envelopes",
        "drop --json/--format (completions are normally piped to a file)",
      )
    }
    // Piped stdout auto-negotiates JSON, but a completion script IS raw
    // output — force text so `lasso --completions bash > file` works.
    mode = { ...mode, format: "text" }
  }

  // Explicit help in a machine format answers with `describe` data directly —
  // but only when the named command exists; help must not mask an invalid
  // command line. (Text-mode help is rendered by the parser runtime.)
  if (mode.format !== "text" && mode.helpRequested) {
    const tokens = preTerminator.filter((arg) => arg !== "--help" && arg !== "-h")
    const known = contracts.some(
      (contract) =>
        tokens.length === 0 ||
        contract.name === tokens.join(" ") ||
        contract.name.startsWith(`${tokens.join(" ")} `),
    )
    if (known) {
      render(mode, { kind: "ok", data: describeData() })
      return ExitCode.success
    }
    return usage(
      `unknown command "${tokens.join(" ")}"`,
      `run ${CLI_NAME} describe --json to list commands`,
    )
  }

  const root = buildRoot(CLI_NAME, CLI_SUMMARY, contracts)
  const rendererLayer = Renderer.layer(mode, CLI_NAME)
  const baseLayer = Layer.mergeAll(
    appServicesLayer.pipe(Layer.provideMerge(rendererLayer)),
    rendererLayer,
  )
  const appLayer = (
    mode.format === "text" ? baseLayer : Layer.mergeAll(baseLayer, machineOutputLayer(mode.format))
  ).pipe(Layer.provideMerge(NodeServices.layer))

  const program = runRoot(root, CLI_VERSION, mode.argv).pipe(Effect.provide(appLayer))

  // SIGINT interrupts the fiber so Effect finalizers (like the store lock
  // release) run before the process exits — and writes nothing to stdout.
  const fiber = Effect.runFork(program)
  process.on("SIGINT", () => {
    Effect.runFork(Fiber.interrupt(fiber))
  })
  const exit: Exit.Exit<void, unknown> = await Effect.runPromise(Fiber.await(fiber))

  const settled = settleExit({ exit, mode, binName: CLI_NAME, describeData })
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
