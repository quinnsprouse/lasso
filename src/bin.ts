import { NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Exit, Layer } from "effect"
import { CliError, CliOutput, Command } from "effect/unstable/cli"
import { describeCli } from "./contract/jsonschema.ts"
import { AppError } from "./errors.ts"
import { ExitCode } from "./output/exit.ts"
import { FormatNegotiationError, negotiate } from "./output/format.ts"
import type { OutputMode } from "./output/format.ts"
import { Renderer } from "./output/renderer.ts"
import { SCHEMA_VERSION } from "./output/envelope.ts"
import { buildRoot, ExitSignal } from "./contract/adapter.ts"
import { Store } from "./services/store.ts"
import { CLI_NAME, CLI_SUMMARY, CLI_VERSION } from "./meta.ts"
import { contracts } from "./commands/index.ts"

/**
 * The runtime adapter: the only module that touches `process`, and the only
 * place `Effect.run*` appears. Every failure path funnels through here so
 * errors render exactly once, in the negotiated format, with a mapped exit
 * code — no other module decides what the process prints on failure.
 */

const writeError = (
  mode: OutputMode,
  body: {
    readonly code: string
    readonly message: string
    readonly fix?: string | undefined
    readonly transient: boolean
  },
): void => {
  if (mode.format === "text") {
    const lines = [`error: ${body.message}`]
    if (body.fix !== undefined) {
      lines.push(`fix: ${body.fix}`)
    }
    process.stderr.write(`${lines.join("\n")}\n`)
    return
  }
  const error = {
    code: body.code,
    message: body.message,
    ...(body.fix !== undefined ? { fix: body.fix } : {}),
    transient: body.transient,
  }
  const payload =
    mode.format === "ndjson"
      ? { event: "error", error }
      : { schemaVersion: SCHEMA_VERSION, status: "error", error, warnings: [] }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/**
 * Deliberately no "did you mean" suggestions: fuzzy recovery hints cause
 * agents to make false correction attempts. Unknown input is a hard failure
 * with a deterministic discovery path.
 */
const usageErrorFrom = (
  error: CliError.CliError,
): { message: string; fix?: string | undefined } => {
  switch (error._tag) {
    case "UnrecognizedOption":
      return {
        message: `unrecognized flag "${error.option}"`,
        fix: `run ${CLI_NAME} describe --json to list valid flags`,
      }
    case "DuplicateOption":
      return { message: `flag "${error.option}" was given more than once` }
    case "MissingOption":
      return { message: `missing required flag "${error.option}"` }
    case "MissingArgument":
      return { message: `missing required argument "${error.argument}"` }
    case "UnexpectedArgument":
      return { message: `unexpected argument(s): ${error.arguments.join(" ")}` }
    case "InvalidValue":
      return {
        message: `invalid value "${error.value}" for "${error.option}" — expected ${error.expected}`,
      }
    case "UnknownSubcommand":
      return {
        message: `unknown command "${error.subcommand}"`,
        fix: `run ${CLI_NAME} describe --json to list commands`,
      }
    case "UserError":
      return { message: error.message }
    case "ShowHelp":
      return { message: "help requested" }
  }
  // Unreachable: the switch is exhaustive over the closed CliError union.
  return { message: String(error) }
}

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
      writeError(error.mode, {
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
  // agents should never have to parse help text.
  if (mode.format !== "text" && mode.argv.some((arg) => arg === "--help" || arg === "-h")) {
    const payload = describeCli({
      binName: CLI_NAME,
      version: CLI_VERSION,
      contracts,
    })
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, status: "ok", data: payload, warnings: [] })}\n`,
    )
    return ExitCode.success
  }

  const root = buildRoot(CLI_NAME, CLI_SUMMARY, contracts)

  // In machine formats, help text must never reach stdout: envelopes only.
  // The formatter is silenced and ShowHelp is answered with `describe` data.
  const baseFormatter = CliOutput.defaultFormatter({ colors: false })
  const machineFormatter: CliOutput.Formatter = {
    formatCliError: (error) => baseFormatter.formatCliError(error),
    formatError: (error) => baseFormatter.formatError(error),
    formatErrors: (errors) => baseFormatter.formatErrors(errors),
    formatHelpDoc: () => "",
    formatVersion: (name, version) =>
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        status: "ok",
        data: { name, version },
        warnings: [],
      }),
  }

  // The CLI runtime prints help via Console.log; the suppressed formatter
  // would still emit a bare newline. In machine formats stdout carries
  // envelopes only, so whitespace-only console writes are dropped.
  const machineConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...args: ReadonlyArray<unknown>) => {
      if (args.every((arg) => typeof arg === "string" && arg.trim() === "")) {
        return
      }
      globalThis.console.log(...args)
    },
  })

  const appServices = Layer.mergeAll(Store.layer, Renderer.layer(mode, CLI_NAME))
  const machineServices = Layer.mergeAll(
    CliOutput.layer(machineFormatter),
    Layer.succeed(Console.Console, machineConsole),
  )
  const appLayer = (
    mode.format === "text" ? appServices : Layer.mergeAll(appServices, machineServices)
  ).pipe(Layer.provideMerge(NodeServices.layer))

  const program = Command.runWith(root, { version: CLI_VERSION })(mode.argv).pipe(
    Effect.provide(appLayer),
  )

  const exit: Exit.Exit<void, unknown> = await Effect.runPromiseExit(program)

  if (Exit.isSuccess(exit)) {
    return ExitCode.success
  }

  if (Cause.hasInterruptsOnly(exit.cause)) {
    return ExitCode.interrupted
  }

  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") {
    const error = failure.value
    if (error instanceof ExitSignal) {
      return error.code
    }
    if (error instanceof AppError) {
      writeError(mode, error)
      return error.exit
    }
    if (error instanceof CliError.ShowHelp) {
      if (error.errors.length === 0) {
        // Explicit --help. Text help already rendered; machine modes get
        // the describe payload so agents never need to parse help text.
        if (mode.format !== "text") {
          const payload = describeCli({
            binName: CLI_NAME,
            version: CLI_VERSION,
            contracts,
          })
          process.stdout.write(
            `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, status: "ok", data: payload, warnings: [] })}\n`,
          )
        }
        return ExitCode.success
      }
      // Parse/validation failure. The text formatter already reported it;
      // machine modes emit the envelope for the first underlying error.
      if (mode.format !== "text") {
        const usage = usageErrorFrom(error.errors[0]!)
        writeError(mode, {
          code: "invalid_usage",
          message: usage.message,
          ...(usage.fix !== undefined ? { fix: usage.fix } : {}),
          transient: false,
        })
      }
      return ExitCode.usage
    }
    if (CliError.isCliError(error)) {
      const usage = usageErrorFrom(error)
      if (mode.format !== "text") {
        writeError(mode, {
          code: "invalid_usage",
          message: usage.message,
          ...(usage.fix !== undefined ? { fix: usage.fix } : {}),
          transient: false,
        })
      }
      return ExitCode.usage
    }
  }

  const defect = Cause.squash(exit.cause)
  if (isEpipe(defect)) {
    return ExitCode.success
  }
  writeError(mode, {
    code: "internal_error",
    message: defect instanceof Error ? defect.message : String(defect),
    transient: false,
  })
  return ExitCode.internalDefect
}

const isEpipe = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "EPIPE"

process.on("SIGINT", () => {
  process.exitCode = ExitCode.interrupted
  process.stdout.write("\n")
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
