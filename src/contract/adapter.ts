// oxlint-disable-next-line effecttsgo/node-builtin-import -- the stderr console bridge is the process boundary
import { Console as NodeConsole } from "node:console"
import { Console, Effect, Layer, Logger, Result, Schema } from "effect"
import {
  Argument,
  CliConfig,
  CliError,
  CliOutput,
  Command,
  Flag,
  GlobalFlag,
} from "effect/unstable/cli"
import { AppError, Errors } from "../errors.ts"
import { negotiate } from "../output/format.ts"
import type { OutputMode } from "../output/format.ts"
import { DISCOVER } from "../output/guidance.ts"
import { Renderer } from "../output/renderer.ts"
import type { AnyContract } from "./contract.ts"
import type { RawInput } from "./execute.ts"
import { runMutation, runQuery, splitInput, validateControls } from "./execute.ts"
import { withMachineFormat } from "./guidance.ts"
import { describeCli } from "./jsonschema.ts"
import type { CommandSurface, SurfaceParam } from "./surface.ts"
import { surfaceOf } from "./surface.ts"

// The only parser import boundary: builds the command tree from the normalized
// surfaces, runs it, and translates parser failures into kit-owned ones.

const flagFor = (param: SurfaceParam): Flag.Flag<unknown> => {
  const name = param.cliName.replace(/^--/, "")
  const described = <A>(flag: Flag.Flag<A>): Flag.Flag<A> => {
    const withDescription = flag.pipe(Flag.withDescription(param.description))
    return param.alias === undefined
      ? withDescription
      : withDescription.pipe(Flag.withAlias(param.alias))
  }
  // atMost(1) makes a repeated scalar flag a parse error instead of a silent first-wins.
  const single = <A>(flag: Flag.Flag<A>): Flag.Flag<A | undefined> =>
    described(flag).pipe(
      Flag.atMost(1),
      Flag.map((values) => values[0] ?? (param.default as A | undefined)),
    )
  switch (param.type) {
    case "boolean":
      // Absent means false; a contradiction like `--yes --no-yes` is a parse error.
      return single(Flag.Boolean(name)).pipe(Flag.map((value) => value ?? false))
    case "integer":
      return single(Flag.Int(name))
    case "choice":
      return single(Flag.Literals(name, param.choices ?? []))
    case "path":
      return single(Flag.Path(name))
    case "string":
      return single(Flag.String(name))
  }
}

const argumentFor = (param: SurfaceParam): Argument.Argument<unknown> => {
  const name = param.cliName.replace(/^<|>$/g, "")
  const typed = (): Argument.Argument<unknown> => {
    switch (param.type) {
      case "integer":
        return Argument.Int(name)
      case "choice":
        return Argument.Literals(name, param.choices ?? [])
      case "path":
        return Argument.Path(name)
      default:
        return Argument.String(name)
    }
  }
  return typed().pipe(Argument.withDescription(param.description))
}

// Help mode makes positionals optional so `--help` never demands them.
const paramsFor = (surface: CommandSurface, help: boolean): Record<string, unknown> =>
  Object.fromEntries(
    surface.params.map((param) => [
      param.key,
      param.kind === "flag"
        ? flagFor(param)
        : help
          ? argumentFor(param).pipe(Argument.optional)
          : argumentFor(param),
    ]),
  )

export type ParserServices = Command.Environment

type LeafHandler<E, R> = (surface: CommandSurface, raw: RawInput) => Effect.Effect<void, E, R>

// The parser's types track each command's params; a roster built at runtime
// has none to track, hence the `never` casts at this one seam.
const commandTree = <E, R>(
  binName: string,
  summary: string,
  surfaces: ReadonlyArray<CommandSurface>,
  handler: LeafHandler<E, R>,
  help = false,
) => {
  const leaf = (surface: CommandSurface) =>
    Command.make(
      surface.path.at(-1)!,
      paramsFor(surface, help) as never,
      ((raw: RawInput) => handler(surface, raw)) as never,
    ).pipe(
      Command.withDescription(surface.contract.summary),
      Command.withExamples(surface.contract.examples.map((example) => ({ ...example }))),
    )
  const groups = new Map<string, Array<CommandSurface>>()
  const topLevel: Array<CommandSurface> = []
  for (const surface of surfaces) {
    const [group, leafName] = surface.path
    if (surface.path.length > 2) {
      throw new Error(`command paths deeper than two levels are not supported: "${surface.name}"`)
    }
    if (leafName === undefined) {
      topLevel.push(surface)
    } else {
      groups.set(group!, [...(groups.get(group!) ?? []), surface])
    }
  }
  return Command.make(binName).pipe(
    Command.withDescription(summary),
    Command.withSubcommands([
      ...[...groups].map(([name, members]) =>
        Command.make(name).pipe(
          Command.withDescription(`${name} commands`),
          Command.withSubcommands(members.map(leaf) as never),
        ),
      ),
      ...topLevel.map(leaf),
    ] as never),
  ) as Command.Command<string, {}, {}, E, R>
}

// The validation tree uses the real parser with inert handlers and action flags.
// It cannot run a query, plan, apply, wizard, or completion generator.
export const inspectInvocation = Effect.fn("inspectInvocation")(function* (
  surfaces: ReadonlyArray<CommandSurface>,
  mode: OutputMode,
) {
  let command: CommandSurface | undefined
  const root = commandTree(
    "cli",
    "",
    surfaces,
    (surface, raw) =>
      Effect.andThen(
        surface.contract.kind === "mutation" && !mode.helpRequested
          ? validateControls(splitInput(surface, raw).controls)
          : Effect.void,
        Effect.sync(() => {
          command = surface
        }),
      ),
    mode.helpRequested,
  )
  const builtIns = GlobalFlag.BuiltIns.map((flag) =>
    flag._tag === "Action" ? { ...flag, run: () => Effect.void } : flag,
  )
  const console: Console.Console = Object.assign(Object.create(yield* Console.Console), {
    log: () => {},
    error: () => {},
  })
  const result = yield* Command.runWith(root, { version: "", renderErrors: false })(mode.argv).pipe(
    Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns })),
    Effect.provideService(Console.Console, console),
    Effect.result,
  )
  if (Result.isSuccess(result)) {
    return { command, reason: undefined }
  }
  if (isAppError(result.failure)) {
    return { command, reason: result.failure.message }
  }
  const failure = classifyParserError(result.failure, "cli")
  return { command, reason: failure?.kind === "usage" ? failure.failure.message : undefined }
})

const isAppError = Schema.is(AppError)

/** The reason `args` would fail against the surface, or undefined when they parse. */
export const validateInvocation = Effect.fn("validateInvocation")(function* (
  surfaces: ReadonlyArray<CommandSurface>,
  args: ReadonlyArray<string>,
) {
  const negotiated = yield* Effect.try({
    try: () => negotiate({ argv: args, stdoutIsTTY: false, stdinIsTTY: false, env: {} }),
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(Effect.result)
  if (Result.isFailure(negotiated)) {
    return negotiated.failure
  }
  return (yield* inspectInvocation(surfaces, negotiated.success)).reason
})

export const runCli = Effect.fn("runCli")(function* (options: {
  readonly binName: string
  readonly summary: string
  readonly version: string
  readonly contracts: ReadonlyArray<AnyContract>
}) {
  const renderer = yield* Renderer
  const mode = renderer.mode
  const surfaces = options.contracts.map(surfaceOf)
  if (mode.helpRequested && mode.format !== "text") {
    const { reason } = yield* inspectInvocation(surfaces, mode)
    if (reason !== undefined) {
      return yield* Errors.invalidUsage({
        message: reason,
        fix: `run ${options.binName} describe --json to list valid flags`,
        next: [DISCOVER],
      })
    }
    return yield* renderer.emit({ kind: "ok", data: describeCli(options) })
  }
  const validate = (args: ReadonlyArray<string>) => validateInvocation(surfaces, args)
  const root = commandTree(options.binName, options.summary, surfaces, (surface, raw) => {
    const contract = surface.contract
    return contract.kind === "mutation"
      ? runMutation(surface, contract, raw, validate)
      : runQuery(surface, contract, raw, validate)
  })
  const argv = mode.helpRequested ? withMachineFormat(mode.argv, ["--help"]) : mode.argv
  // renderOutcome owns error rendering in every format: the parser renders none.
  return yield* Command.runWith(root, { version: options.version, renderErrors: false })(argv)
})

/**
 * In machine formats, help text must never reach stdout: the formatter is
 * silenced (runCli answers help with describe data) and whitespace-only console
 * writes from the parser runtime are dropped.
 */
const machineFormatterBase = CliOutput.defaultFormatter({ colors: false })

const machineConfigLayer = Layer.effect(
  CliConfig.CliConfig,
  Effect.gen(function* () {
    const renderer = yield* Renderer
    return CliConfig.make({
      builtIns: GlobalFlag.BuiltIns.map((flag) =>
        flag === GlobalFlag.Version
          ? GlobalFlag.Action({
              flag: GlobalFlag.Version.flag,
              run: (_value: boolean, { command, version }: GlobalFlag.HandlerContext) =>
                renderer.emit({ kind: "ok", data: { name: command.name, version } }),
            })
          : flag,
      ),
    })
  }),
)

const machineOutputLayer = (stderr: Console.Console) =>
  Layer.mergeAll(
    CliOutput.layer(
      Object.assign(Object.create(machineFormatterBase), { formatHelpDoc: () => "" }),
    ),
    Layer.succeed(
      Console.Console,
      Object.assign(Object.create(stderr), {
        log: (...args: ReadonlyArray<unknown>) => {
          if (!args.every((arg) => typeof arg === "string" && arg.trim() === ""))
            stderr.log(...args)
        },
      }),
    ),
    machineConfigLayer,
  )

interface OutputStreams {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
}

/**
 * The parser's output for a negotiated mode. Text keeps help on stdout, in
 * color only where the mode allows it; machine formats silence help and send
 * every console write to stderr. Logs are diagnostics in every format. The
 * default streams are the process's: this is the stderr console bridge, the
 * one place outside bin.ts that touches the process.
 */
export const outputLayer = (mode: OutputMode, streams: OutputStreams = process) =>
  Layer.mergeAll(
    Layer.succeed(Logger.LogToStderr, true),
    mode.format === "text"
      ? Layer.mergeAll(
          CliOutput.layer(CliOutput.defaultFormatter({ colors: mode.color })),
          Layer.succeed(Console.Console, new NodeConsole(streams)),
        )
      : machineOutputLayer(new NodeConsole({ stdout: streams.stderr, stderr: streams.stderr })),
  )

/** Kit-owned classification of a failed run — bin.ts never sees parser types. */
export type RunFailure =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly failure: AppErrorLike }
  | null

interface AppErrorLike {
  readonly message: string
  readonly fix: string
  /** A mistyped token and the parser's closest valid spellings, for corrected next moves. */
  readonly correction?: { readonly token: string; readonly candidates: ReadonlyArray<string> }
}

// The parser's suggestions become corrected next moves only after settleExit
// validates them against the surface; the fix stays a deterministic pointer.
const usageErrorFrom = (error: CliError.CliError, binName: string): AppErrorLike => {
  switch (error._tag) {
    case "UnrecognizedOption":
      return {
        message: `unrecognized flag "${error.option}"`,
        fix: `run ${binName} describe --json to list valid flags`,
        correction: { token: error.option, candidates: error.suggestions },
      }
    case "DuplicateOption":
      return {
        message: `flag "${error.option}" was given more than once`,
        fix: `pass "${error.option}" a single time`,
      }
    case "MissingOption":
      return {
        message: `missing required flag "${error.option}"`,
        fix: `add "${error.option}"; run ${binName} describe --json for its type`,
      }
    case "MissingArgument":
      return {
        message: `missing required argument "${error.argument}"`,
        fix: `provide "${error.argument}"; run ${binName} describe --json for its type`,
      }
    case "UnexpectedArgument":
      return {
        message: `unexpected argument(s): ${error.arguments.join(" ")}`,
        fix: `remove them; run ${binName} describe --json to see accepted arguments`,
      }
    case "InvalidValue": {
      const expected = error.expected.replace(/^Expected\s+/i, "")
      return {
        message: `invalid value "${error.value}" for "${error.option}" — expected ${expected}`,
        fix: `pass ${expected} for "${error.option}"`,
      }
    }
    case "UnknownSubcommand":
      return {
        message: `unknown command "${[...(error.parent?.slice(1) ?? []), error.subcommand].join(" ")}"`,
        fix: `run ${binName} describe --json to list commands`,
        correction: { token: error.subcommand, candidates: error.suggestions },
      }
    case "UserError":
      return {
        message: error.message,
        fix: `run ${binName} describe --json to see the accepted inputs`,
      }
    case "ShowHelp":
      return {
        message: "help requested",
        fix: `run ${binName} describe --json for machine-readable help`,
      }
  }
}

/** Translates parser errors into kit-owned failures; returns null for non-parser errors. */
export const classifyParserError = (error: unknown, binName: string): RunFailure => {
  if (CliError.isCliError(error) && error._tag === "ShowHelp") {
    // Help with parse errors is a usage failure that happened to show help.
    const first = error.errors[0]
    return first === undefined
      ? { kind: "help" }
      : { kind: "usage", failure: usageErrorFrom(first, binName) }
  }
  if (CliError.isCliError(error)) {
    return { kind: "usage", failure: usageErrorFrom(error, binName) }
  }
  return null
}
