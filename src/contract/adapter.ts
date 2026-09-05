import { Console as NodeConsole } from "node:console"
import { Console, Effect, Layer, Schema } from "effect"
import {
  Argument,
  CliConfig,
  CliError,
  CliOutput,
  Command,
  Flag,
  GlobalFlag,
} from "effect/unstable/cli"
import type { AppError } from "../errors.ts"
import { Errors } from "../errors.ts"
import { Renderer } from "../output/renderer.ts"
import { SCHEMA_VERSION } from "../output/envelope.ts"
import type { AppServices } from "../services/index.ts"
import type {
  AnyContract,
  InputOf,
  MutationContract,
  ParamSpec,
  QueryContract,
} from "./contract.ts"
import type { CommandSurface, SurfaceParam } from "./surface.ts"
import { surfaceOf } from "./surface.ts"
import { planToken } from "./token.ts"
import { finalizeGuidance, formatArgs, withMachineFormat, withoutFlag } from "./guidance.ts"
import { AppError as AppErrorClass } from "../errors.ts"
import { negotiate } from "../output/format.ts"
import type { OutputMode } from "../output/format.ts"
import { describeCli } from "./jsonschema.ts"
import type { GuideTopic } from "../guides/catalog.generated.ts"

// The only parser import boundary; commands are built from the normalized contracts.

/** Control-flow signal: the outcome was already rendered; exit with this code. */
export class ExitSignal extends Schema.TaggedError<ExitSignal>()("ExitSignal", {
  code: Schema.Int,
}) {}

type Handled = Effect.Effect<void, AppError | ExitSignal, AppServices | Renderer | ParserServices>

/** The next move after any usage error: discover the real surface. */
const DISCOVER = [{ message: "list every command and flag", args: ["describe", "--json"] }]

/** Framework controls, split from domain input before any handler runs. */
interface Controls {
  readonly dryRun: boolean
  readonly confirm: string | undefined
  readonly yes: boolean
  readonly fields: string | undefined
}

const validateControls = (controls: Controls): Effect.Effect<void, AppError> => {
  if (controls.dryRun && (controls.yes || controls.confirm !== undefined)) {
    return Effect.fail(
      Errors.invalidUsage({
        message: "--dry-run cannot be combined with --yes or --confirm",
        fix: "preview with --dry-run alone, then apply with --yes or --confirm",
        next: DISCOVER,
      }),
    )
  }
  if (controls.yes && controls.confirm !== undefined) {
    return Effect.fail(
      Errors.invalidUsage({
        message: "--yes and --confirm are mutually exclusive",
        fix: "use --confirm <token> to apply a previewed plan, or --yes to skip the preview",
        next: DISCOVER,
      }),
    )
  }

  return Effect.void
}

const splitInput = (
  surface: CommandSurface,
  raw: Record<string, unknown>,
): { domain: Record<string, unknown>; controls: Controls } => {
  const frameworkKeys = new Set(
    surface.params.filter((param) => param.owner === "framework").map((param) => param.key),
  )
  const domain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!frameworkKeys.has(key)) {
      domain[key] = value
    }
  }
  return {
    domain,
    controls: {
      dryRun: raw["dryRun"] === true,
      confirm: typeof raw["confirm"] === "string" ? raw["confirm"] : undefined,
      yes: raw["yes"] === true,
      fields: typeof raw["fields"] === "string" ? raw["fields"] : undefined,
    },
  }
}

const flagFor = (param: SurfaceParam): Flag.Flag<unknown> => {
  const name = param.cliName.replace(/^--/, "")
  const withMeta = <A>(flag: Flag.Flag<A>): Flag.Flag<A> => {
    const described = flag.pipe(Flag.withDescription(param.description))
    return param.alias === undefined ? described : described.pipe(Flag.withAlias(param.alias))
  }
  // atMost(1) makes a repeated scalar flag a parse error instead of a
  // silent first-wins; the array result is unwrapped to the single value.
  const optionalized = <A>(flag: Flag.Flag<A>): Flag.Flag<A | undefined> =>
    param.default !== undefined
      ? withMeta(flag).pipe(
          Flag.atMost(1),
          Flag.map((values) => values[0] ?? (param.default as A)),
        )
      : withMeta(flag).pipe(
          Flag.atMost(1),
          Flag.map((values) => values[0]),
        )

  switch (param.type) {
    case "boolean":
      return withMeta(Flag.boolean(name))
    case "integer":
      return optionalized(Flag.integer(name))
    case "choice":
      return optionalized(Flag.choice(name, (param.choices ?? []) as Array<string>))
    case "path":
      return optionalized(Flag.path(name))
    case "string":
      return optionalized(Flag.string(name))
  }
}

const argumentFor = (param: SurfaceParam): Argument.Argument<unknown> => {
  const name = param.cliName.replace(/^<|>$/g, "")
  switch (param.type) {
    case "integer":
      return Argument.integer(name).pipe(Argument.withDescription(param.description))
    case "choice":
      return Argument.choice(name, (param.choices ?? []) as Array<string>).pipe(
        Argument.withDescription(param.description),
      )
    case "path":
      return Argument.path(name).pipe(Argument.withDescription(param.description))
    default:
      return Argument.string(name).pipe(Argument.withDescription(param.description))
  }
}

const paramsFor = (surface: CommandSurface, help = false): Record<string, unknown> =>
  Object.fromEntries(
    surface.params.map((param) => [
      param.key,
      param.kind === "argument"
        ? help
          ? argumentFor(param).pipe(Argument.optional)
          : argumentFor(param)
        : flagFor(param),
    ]),
  )

const encodeOutput = (contract: AnyContract, data: unknown): Effect.Effect<unknown, AppError> =>
  Schema.encodeUnknownEffect(contract.dataSchema)(data).pipe(
    Effect.mapError((cause) =>
      Errors.invalidData({
        message: `output failed its declared schema: ${cause.message}`,
        fix: `this is a bug in "${contract.name}": make its handler return data matching dataSchema`,
      }),
    ),
  )

// Validate against declared fields even for empty collections, then project encoded rows.
const project = (
  surface: CommandSurface,
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: string,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, AppError> => {
  const contract = surface.contract as QueryContract
  const inventory: ReadonlyArray<string> = contract.collection?.fields ?? []
  const wanted = [
    ...new Set(
      fields
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field.length > 0),
    ),
  ]
  if (wanted.length === 0) {
    return Effect.fail(
      Errors.invalidUsage({
        message: "--fields requires at least one field name",
        fix: `use fields from: ${inventory.join(", ")}`,
        next: DISCOVER,
      }),
    )
  }
  const unknown = wanted.filter((field) => !inventory.includes(field))
  if (unknown.length > 0) {
    return Effect.fail(
      Errors.invalidUsage({
        message: `unknown field(s): ${unknown.join(", ")}`,
        fix: `use fields from: ${inventory.join(", ")}`,
        next: DISCOVER,
      }),
    )
  }
  return Effect.succeed(
    rows.map((row) => Object.fromEntries(wanted.map((field) => [field, row[field]]))),
  )
}

// An explicit guides array, including [], overrides the command's defaults.
const withCommandGuides =
  (surface: CommandSurface) =>
  (error: AppError): AppError =>
    error.guides !== undefined || surface.guides.length === 0
      ? error
      : new AppErrorClass({
          code: error.code,
          message: error.message,
          fix: error.fix,
          transient: error.transient,
          exit: error.exit,
          ...(error.details !== undefined ? { details: error.details } : {}),
          ...(error.next !== undefined ? { next: error.next } : {}),
          guides: surface.guides,
        })

const runQuery = Effect.fn("runQuery")(function* (
  surface: CommandSurface,
  all: ReadonlyArray<CommandSurface>,
  raw: Record<string, unknown>,
): Effect.fn.Return<void, AppError | ExitSignal, AppServices | Renderer | ParserServices> {
  const contract = surface.contract as QueryContract<
    Record<string, ParamSpec>,
    unknown,
    AppServices
  >
  const renderer = yield* Renderer
  const { domain, controls } = splitInput(surface, raw)

  if (controls.fields !== undefined && renderer.mode.format === "text") {
    return yield* Errors.invalidUsage({
      message: "--fields projection requires a machine format",
      fix: "add --json or --format ndjson",
      next: DISCOVER,
    })
  }

  const data = yield* contract
    .handler(domain as InputOf<Record<string, ParamSpec>>)
    .pipe(Effect.mapError(withCommandGuides(surface)))
  const encoded = yield* encodeOutput(contract, data)
  // Success offers next moves; guides are reserved for decisions and failures.
  const guidance = yield* finalizeGuidance((args) => validateInvocation(all, args), {
    next: contract.next?.({ input: domain as InputOf<Record<string, ParamSpec>>, data }),
  })
  const rows = contract.collection?.items(encoded)
  if (rows !== undefined) {
    const inventory = new Set<string>(contract.collection?.fields ?? [])
    const stray = rows.flatMap((row) => Object.keys(row)).find((key) => !inventory.has(key))
    if (stray !== undefined) {
      return yield* Errors.invalidData({
        message: `collection row field "${stray}" is not in the declared fields inventory`,
        fix: `add "${stray}" to the collection.fields of "${surface.name}"`,
      })
    }
  }

  if (controls.fields !== undefined && rows !== undefined) {
    const projected = yield* project(surface, rows, controls.fields)
    yield* renderer
      .emit({
        kind: "ok",
        data: { items: projected, count: projected.length },
        items: projected,
        ...guidance,
      })
      .pipe(Effect.orDie)
    return
  }

  yield* renderer
    .emit({
      kind: "ok",
      data: encoded,
      ...(contract.renderText !== undefined ? { text: contract.renderText(data) } : {}),
      ...(rows !== undefined ? { items: rows } : {}),
      ...guidance,
    })
    .pipe(Effect.orDie)
})

const runMutation = Effect.fn("runMutation")(function* (
  surface: CommandSurface,
  all: ReadonlyArray<CommandSurface>,
  raw: Record<string, unknown>,
): Effect.fn.Return<void, AppError | ExitSignal, AppServices | Renderer | ParserServices> {
  const contract = surface.contract as MutationContract<
    Record<string, ParamSpec>,
    unknown,
    unknown,
    AppServices,
    AppServices
  >
  const renderer = yield* Renderer
  const { domain, controls } = splitInput(surface, raw)

  yield* validateControls(controls)

  const original = renderer.mode.argv
  const machine = formatArgs(renderer.mode.format)
  /** The same invocation without --confirm: a fresh preview against current state. */
  const replan = withMachineFormat(withoutFlag(original, "--confirm", true), machine)
  const planEffect = contract
    .plan(domain as InputOf<Record<string, ParamSpec>>)
    .pipe(Effect.mapError(withCommandGuides(surface)))
  const rawPlan = yield* controls.confirm === undefined
    ? planEffect
    : planEffect.pipe(
        Effect.catch((cause) =>
          Errors.staleConfirmation({
            message: `the previewed plan can no longer be produced: ${cause.message}`,
            fix: "re-run without --confirm to get a fresh plan",
            details: { code: cause.code },
            next: [{ message: "re-plan against the current state", args: replan }],
            ...(cause.guides !== undefined
              ? { guides: cause.guides as ReadonlyArray<GuideTopic> }
              : {}),
          }),
        ),
      )
  const encodedPlan = yield* Schema.encodeUnknownEffect(contract.planSchema)(rawPlan).pipe(
    Effect.mapError((cause) =>
      Errors.invalidData({
        message: `plan failed its declared schema: ${cause.message}`,
        fix: `this is a bug in "${surface.name}": make its plan return data matching planSchema`,
      }),
    ),
  )
  // The token binds command identity, protocol version, and the full plan.
  const token = planToken({
    command: surface.name,
    schemaVersion: SCHEMA_VERSION,
    plan: encodedPlan,
  })
  // What was previewed and hashed is the ENCODED plan. Apply (and the human
  // preview) receive its decoded form, never the raw value the plan function
  // returned, so nothing the schema does not carry can reach apply.
  const plan = yield* Schema.decodeUnknownEffect(contract.planSchema)(encodedPlan).pipe(
    Effect.mapError((cause) =>
      Errors.invalidData({
        message: `plan does not round-trip through its schema: ${cause.message}`,
        fix: `this is a bug in "${surface.name}": make planSchema encode and decode the plan losslessly`,
      }),
    ),
  )

  if (controls.dryRun) {
    // Preview-first: the next move is the confirmation flow, never a generated --yes.
    const guidance = yield* finalizeGuidance((args) => validateInvocation(all, args), {
      next: [
        {
          message: "re-run without --dry-run to get a confirmation token",
          args: withMachineFormat(withoutFlag(original, "--dry-run"), machine),
        },
      ],
      guides: surface.guides,
    })
    yield* renderer
      .emit({
        kind: "ok",
        data: { dryRun: true, plan: encodedPlan },
        ...(contract.renderPlanText !== undefined
          ? { text: `${contract.renderPlanText(plan)}\n(dry run — nothing was changed)` }
          : {}),
        ...guidance,
      })
      .pipe(Effect.orDie)
    return
  }

  if (controls.confirm !== undefined) {
    if (controls.confirm !== token) {
      return yield* Errors.staleConfirmation({
        message:
          "the confirmation token does not match the current plan — state changed since the plan was produced",
        fix: "re-run without --confirm to get a fresh plan, then confirm with the new token",
        next: [{ message: "re-plan against the current state", args: replan }],
        ...(surface.guides.length > 0 ? { guides: surface.guides } : {}),
      })
    }
  } else if (!controls.yes) {
    // The canonical continuation pins the machine format explicitly so a
    // replay under a TTY still produces machine output. Controls are
    // inserted BEFORE any -- terminator so the replay parses verbatim.
    const confirmArgs = withMachineFormat(original, [
      "--confirm",
      token,
      ...(machine.length > 0 ? machine : ["--json"]),
    ])
    const guidance = yield* finalizeGuidance((args) => validateInvocation(all, args), {
      next: [{ message: "apply exactly this plan", args: confirmArgs }],
      guides: surface.guides,
    })
    yield* renderer
      .emit({
        kind: "confirmation",
        plan: encodedPlan,
        token,
        confirmArgs,
        ...(contract.renderPlanText !== undefined ? { text: contract.renderPlanText(plan) } : {}),
        ...guidance,
      })
      .pipe(Effect.orDie)
    return yield* new ExitSignal({ code: 4 })
  }

  const data = yield* contract.apply(plan).pipe(Effect.mapError(withCommandGuides(surface)))
  const encoded = yield* encodeOutput(contract, data)
  const guidance = yield* finalizeGuidance((args) => validateInvocation(all, args), {
    next: contract.next?.({ input: domain as InputOf<Record<string, ParamSpec>>, data }),
  })
  yield* renderer
    .emit({
      kind: "ok",
      data: encoded,
      ...(contract.renderText !== undefined ? { text: contract.renderText(data) } : {}),
      ...guidance,
    })
    .pipe(Effect.orDie)
})

export type ParserServices = Command.Environment

type LeafHandler<E, R> = (
  surface: CommandSurface,
  raw: Record<string, unknown>,
) => Effect.Effect<void, E, R>

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
      ((raw: Record<string, unknown>) => handler(surface, raw)) as never,
    ).pipe(
      Command.withDescription(surface.contract.summary),
      Command.withExamples(surface.contract.examples.map((example) => ({ ...example }))),
    )
  const groups = new Map<string, Array<CommandSurface>>()
  const topLevel: Array<CommandSurface> = []
  for (const surface of surfaces) {
    if (surface.path.length === 1) topLevel.push(surface)
    else if (surface.path.length === 2) {
      const group = groups.get(surface.path[0]!) ?? []
      group.push(surface)
      groups.set(surface.path[0]!, group)
    } else
      throw new Error(`command paths deeper than two levels are not supported: "${surface.name}"`)
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
  const result = yield* Command.runWith(root, { version: "" })(mode.argv).pipe(
    Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns })),
    Effect.provideService(Console.Console, console),
    Effect.result,
  )
  if (result._tag === "Success") return { command, reason: undefined }
  const error = result.failure
  if (Schema.is(AppErrorClass)(error)) return { command, reason: error.message }
  const failure = classifyParserError(error, "cli")
  return { command, reason: failure?.kind === "usage" ? failure.failure.message : undefined }
})

export const validateInvocation = Effect.fn("validateInvocation")(function* (
  surfaces: ReadonlyArray<CommandSurface>,
  args: ReadonlyArray<string>,
) {
  const negotiated = yield* Effect.try({
    try: () => negotiate({ argv: args, stdoutIsTTY: false, stdinIsTTY: false, env: {} }),
    catch: (error) =>
      Errors.invalidUsage({
        message: error instanceof Error ? error.message : String(error),
        fix: "check the invocation flags",
      }),
  }).pipe(Effect.result)
  if (negotiated._tag === "Failure") {
    return negotiated.failure.message
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
    if (reason !== undefined)
      return yield* Errors.invalidUsage({
        message: reason,
        fix: `run ${options.binName} describe --json to list valid flags`,
        next: DISCOVER,
      })
    return yield* renderer.emit({ kind: "ok", data: describeCli(options) }).pipe(Effect.orDie)
  }
  const root = commandTree(
    options.binName,
    options.summary,
    surfaces,
    (surface, raw): Handled =>
      surface.contract.kind === "mutation"
        ? runMutation(surface, surfaces, raw)
        : runQuery(surface, surfaces, raw),
  )
  const argv = mode.helpRequested ? withMachineFormat(mode.argv, ["--help"]) : mode.argv
  return yield* Command.runWith(root, { version: options.version })(argv)
})

/**
 * In machine formats, help text must never reach stdout: the formatter is
 * silenced (runCli answers help with describe data) and whitespace-only console
 * writes from the parser runtime are dropped.
 */
const machineFormatterBase = CliOutput.defaultFormatter({ colors: false })

const stderrConsole = new NodeConsole({ stdout: process.stderr, stderr: process.stderr })
const quietConsole: Console.Console = Object.assign(Object.create(stderrConsole), {
  log: (...args: ReadonlyArray<unknown>) => {
    if (!args.every((arg) => typeof arg === "string" && arg.trim() === ""))
      stderrConsole.log(...args)
  },
})

export const machineOutputLayer = Layer.mergeAll(
  CliOutput.layer(Object.assign(Object.create(machineFormatterBase), { formatHelpDoc: () => "" })),
  Layer.succeed(Console.Console, quietConsole),
  Layer.effect(
    CliConfig.CliConfig,
    Effect.gen(function* () {
      const renderer = yield* Renderer
      return CliConfig.make({
        builtIns: GlobalFlag.BuiltIns.map((flag) =>
          flag === GlobalFlag.Version
            ? GlobalFlag.action({
                flag: GlobalFlag.Version.flag,
                run: (_value: boolean, { command, version }: GlobalFlag.HandlerContext) =>
                  renderer
                    .emit({
                      kind: "ok",
                      data: { name: command.name, version },
                    })
                    .pipe(Effect.orDie),
              })
            : flag,
        ),
      })
    }),
  ),
)

/** Kit-owned classification of a failed run — bin.ts never sees parser types. */
export type RunFailure =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly failure: AppErrorLike }
  | null

interface AppErrorLike {
  readonly message: string
  readonly fix: string
}

// Use deterministic discovery hints instead of fuzzy command suggestions.
const usageErrorFrom = (error: CliError.CliError, binName: string): AppErrorLike => {
  switch (error._tag) {
    case "UnrecognizedOption":
      return {
        message: `unrecognized flag "${error.option}"`,
        fix: `run ${binName} describe --json to list valid flags`,
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
