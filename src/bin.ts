import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, Layer } from "effect"
import type { Exit } from "effect"
import { buildRoot, machineOutputLayer, runRoot } from "./contract/adapter.ts"
import { withMachineFormat } from "./contract/guidance.ts"
import {
  GLOBAL_FLAG_NAMES,
  resolveCommandPath,
  validateGlobalFlags,
  validateInvocation,
} from "./contract/invocation.ts"
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

/**
 * The process boundary: this module owns argv, signals, the final writes, and
 * the exit status, and is the only place `Effect.run*` appears. (The parser
 * adapter holds one more process-bound piece: the stderr-bound console shim
 * that passes only `--version` to stdout.) All outcome classification lives
 * in `runtime.ts` (shared with the in-process runtime tests); this file just
 * connects it to the real stdout, stderr, and exit code.
 */

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

const isCommand = (name: string): boolean => contracts.some((contract) => contract.name === name)
const isGroup = (word: string): boolean =>
  contracts.some((contract) => contract.name.startsWith(`${word} `))

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
        next: [{ message: "list every command and flag", args: ["describe", "--json"] }],
      })
      return ExitCode.usage
    }
    throw error
  }

  // Interactive/raw built-ins never run in machine formats: the wizard is a
  // prompt loop and completions emit a raw shell script — both would corrupt
  // the envelope protocol. The wizard is also refused when input is closed.
  const usage = (message: string, fix: string): number => {
    render(mode, {
      kind: "failure",
      code: "invalid_usage",
      message,
      fix,
      transient: false,
      next: [{ message: "list every command and flag", args: ["describe", "--json"] }],
    })
    return ExitCode.usage
  }
  const preTerminator = mode.argv.slice(
    0,
    mode.argv.includes("--") ? mode.argv.indexOf("--") : mode.argv.length,
  )
  // Action flags in every spelling (`--wizard=false` still starts the wizard in
  // the parser; treat any spelling as the action).
  const hasAction = (name: string, negatedToo: boolean) =>
    preTerminator.some((arg) =>
      new RegExp(`^(${name}${negatedToo ? `|--no-${name.slice(2)}` : ""})(=.*)?$`).test(arg),
    )
  // An invalid value for a global flag is a usage error before anything else.
  const globalReason = validateGlobalFlags(preTerminator)
  if (globalReason !== undefined) {
    return usage(globalReason, `run ${CLI_NAME} describe --json to list valid flags`)
  }
  if (hasAction("--wizard", true) && (mode.format !== "text" || mode.noInput)) {
    return usage(
      "--wizard is interactive and only available in text mode on a terminal",
      "run without --wizard; use describe --json for machine-readable discovery",
    )
  }
  if (hasAction("--completions", false)) {
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
    // Only the command path matters: `task list --status all --help` names
    // "task list". An unknown flag before the path, or an invalid value for a
    // global flag anywhere, must not be masked by help.
    const tokens = preTerminator
    const resolved = resolveCommandPath(surfaces, tokens)
    if (resolved.error !== undefined && !resolved.error.includes("is not a command")) {
      return usage(resolved.error, `run ${CLI_NAME} describe --json to list valid flags`)
    }
    const named = resolved.named
    // A group alone takes no command flags: `task --bogus list --help` is not help for "task".
    const afterPath = tokens[resolved.rest]
    if (
      isGroup(named) &&
      !isCommand(named) &&
      afterPath !== undefined &&
      afterPath.startsWith("-") &&
      !GLOBAL_FLAG_NAMES.has(afterPath.replace(/=.*$/, ""))
    ) {
      return usage(
        `unrecognized flag "${afterPath}"`,
        `run ${CLI_NAME} describe --json to list valid flags`,
      )
    }
    // A resolved command's own flags must parse too: help never masks `--json=true`.
    if (isCommand(named)) {
      const reason = validateInvocation(
        surfaces,
        tokens.filter((arg) => !/^(--help|-h|--no-help)(=.*)?$/.test(arg)),
      )
      if (reason !== undefined) {
        return usage(reason, `run ${CLI_NAME} describe --json to list valid flags`)
      }
    }
    if (named.length === 0 || isCommand(named) || isGroup(named)) {
      render(mode, { kind: "ok", data: describeData() })
      return ExitCode.success
    }
    return usage(`unknown command "${named}"`, `run ${CLI_NAME} describe --json to list commands`)
  }

  const root = buildRoot(CLI_NAME, CLI_SUMMARY, contracts)
  // provideMerge keeps Renderer in the output context, so one layer object
  // serves both the app services and the runtime — built exactly once.
  const baseLayer = appServicesLayer.pipe(Layer.provideMerge(Renderer.layer(mode, CLI_NAME)))
  const appLayer = (
    mode.format === "text" ? baseLayer : Layer.mergeAll(baseLayer, machineOutputLayer(mode.format))
  ).pipe(Layer.provideMerge(NodeServices.layer))

  // Text-mode help is rendered by the parser: hand it the canonical flag.
  const argv = mode.helpRequested ? withMachineFormat(mode.argv, ["--help"]) : mode.argv
  const program = runRoot(root, CLI_VERSION, argv).pipe(Effect.provide(appLayer))

  // SIGINT interrupts the fiber so Effect finalizers (like the store lock
  // release) run before the process exits — and writes nothing to stdout.
  const fiber = Effect.runFork(program)
  process.on("SIGINT", () => {
    Effect.runFork(Fiber.interrupt(fiber))
  })
  const exit: Exit.Exit<void, unknown> = await Effect.runPromise(Fiber.await(fiber))

  const settled = settleExit({ exit, mode, binName: CLI_NAME, describeData, surfaces })
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
