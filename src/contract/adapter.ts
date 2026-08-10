import { Console, Effect, Layer, Schema } from "effect"
import { Argument, CliError, CliOutput, Command, Flag } from "effect/unstable/cli"
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

/**
 * Maps CommandContracts onto the effect/unstable/cli parser. This module is
 * the ONLY one that imports the parser (lint-enforced); everything it builds
 * derives from the normalized CommandSurface, so the parser can never accept
 * a surface that `describe` and `schema` do not advertise.
 */

/** Control-flow signal: the outcome was already rendered; exit with this code. */
export class ExitSignal extends Schema.TaggedError<ExitSignal>()("ExitSignal", {
  code: Schema.Int,
}) {}

type Handled = Effect.Effect<void, AppError | ExitSignal, AppServices | Renderer>

/** Framework controls, split from domain input before any handler runs. */
interface Controls {
  readonly dryRun: boolean
  readonly confirm: string | undefined
  readonly yes: boolean
  readonly fields: string | undefined
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

const paramsFor = (surface: CommandSurface): Record<string, unknown> =>
  Object.fromEntries(
    surface.params.map((param) => [
      param.key,
      param.kind === "argument" ? argumentFor(param) : flagFor(param),
    ]),
  )

const encodeOutput = (contract: AnyContract, data: unknown): Effect.Effect<unknown, AppError> =>
  Schema.encodeUnknownEffect(contract.dataSchema)(data).pipe(
    Effect.mapError((cause) =>
      Errors.invalidData({ message: `output failed its declared schema: ${cause.message}` }),
    ),
  )

/**
 * Projection is validated against the static field inventory — behavior is
 * identical for empty and populated collections — and applied to ENCODED
 * rows, so JSON, NDJSON, and projection can never disagree.
 */
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
      Errors.usage({
        message: "--fields requires at least one field name",
        fix: `use fields from: ${inventory.join(", ")}`,
      }),
    )
  }
  const unknown = wanted.filter((field) => !inventory.includes(field))
  if (unknown.length > 0) {
    return Effect.fail(
      Errors.usage({
        message: `unknown field(s): ${unknown.join(", ")}`,
        fix: `use fields from: ${inventory.join(", ")}`,
      }),
    )
  }
  return Effect.succeed(
    rows.map((row) => Object.fromEntries(wanted.map((field) => [field, row[field]]))),
  )
}

const runQuery = (surface: CommandSurface, raw: Record<string, unknown>): Handled =>
  Effect.gen(function* () {
    const contract = surface.contract as QueryContract<
      Record<string, ParamSpec>,
      unknown,
      AppServices
    >
    const renderer = yield* Renderer
    const { domain, controls } = splitInput(surface, raw)

    if (controls.fields !== undefined && renderer.mode.format === "text") {
      return yield* Errors.usage({
        message: "--fields projection requires a machine format",
        fix: "add --json or --format ndjson",
      })
    }

    const data = yield* contract.handler(domain as InputOf<Record<string, ParamSpec>>)
    const encoded = yield* encodeOutput(contract, data)
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
      })
      .pipe(Effect.orDie)
  })

const runMutation = (surface: CommandSurface, raw: Record<string, unknown>): Handled =>
  Effect.gen(function* () {
    const contract = surface.contract as MutationContract<
      Record<string, ParamSpec>,
      unknown,
      unknown,
      AppServices,
      AppServices
    >
    const renderer = yield* Renderer
    const { domain, controls } = splitInput(surface, raw)

    // Contradictory control combinations fail before planning.
    if (controls.dryRun && (controls.yes || controls.confirm !== undefined)) {
      return yield* Errors.usage({
        message: "--dry-run cannot be combined with --yes or --confirm",
        fix: "preview with --dry-run alone, then apply with --yes or --confirm",
      })
    }
    if (controls.yes && controls.confirm !== undefined) {
      return yield* Errors.usage({
        message: "--yes and --confirm are mutually exclusive",
        fix: "use --confirm <token> to apply a previewed plan, or --yes to skip the preview",
      })
    }

    const planEffect = contract.plan(domain as InputOf<Record<string, ParamSpec>>)
    const plan = yield* controls.confirm === undefined
      ? planEffect
      : planEffect.pipe(
          Effect.catch((cause) =>
            Errors.staleConfirmation({
              message: `the previewed plan can no longer be produced: ${cause.message}`,
              fix: "re-run without --confirm to get a fresh plan",
              details: { code: cause.code },
            }),
          ),
        )
    const encodedPlan = yield* Schema.encodeUnknownEffect(contract.planSchema)(plan).pipe(
      Effect.mapError((cause) =>
        Errors.invalidData({ message: `plan failed its declared schema: ${cause.message}` }),
      ),
    )
    // The token binds command identity, protocol version, and the full plan.
    const token = planToken({
      command: surface.name,
      schemaVersion: SCHEMA_VERSION,
      plan: encodedPlan,
    })

    if (controls.dryRun) {
      yield* renderer
        .emit({
          kind: "ok",
          data: { dryRun: true, plan: encodedPlan },
          ...(contract.renderPlanText !== undefined
            ? { text: `${contract.renderPlanText(plan)}\n(dry run — nothing was changed)` }
            : {}),
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
        })
      }
    } else if (!controls.yes) {
      // The canonical continuation pins the machine format explicitly so a
      // replay under a TTY still produces machine output. Controls are
      // inserted BEFORE any -- terminator so the replay parses verbatim.
      const formatArgs = renderer.mode.format === "ndjson" ? ["--format", "ndjson"] : ["--json"]
      const controlArgs = ["--confirm", token, ...formatArgs]
      const original = renderer.mode.argv
      const terminator = original.indexOf("--")
      const confirmArgs =
        terminator === -1
          ? [...original, ...controlArgs]
          : [...original.slice(0, terminator), ...controlArgs, ...original.slice(terminator)]
      yield* renderer
        .emit({
          kind: "confirmation",
          plan: encodedPlan,
          token,
          confirmArgs,
          ...(contract.renderPlanText !== undefined ? { text: contract.renderPlanText(plan) } : {}),
        })
        .pipe(Effect.orDie)
      return yield* new ExitSignal({ code: 4 })
    }

    const data = yield* contract.apply(plan)
    const encoded = yield* encodeOutput(contract, data)
    yield* renderer
      .emit({
        kind: "ok",
        data: encoded,
        ...(contract.renderText !== undefined ? { text: contract.renderText(data) } : {}),
      })
      .pipe(Effect.orDie)
  })

const toCommand = (surface: CommandSurface) => {
  const handler = (raw: Record<string, unknown>): Handled =>
    surface.contract.kind === "mutation" ? runMutation(surface, raw) : runQuery(surface, raw)

  const leaf = surface.path[surface.path.length - 1]!
  return Command.make(leaf, paramsFor(surface) as never, handler as never).pipe(
    Command.withDescription(surface.contract.summary),
    Command.withExamples(surface.contract.examples.map((example) => ({ ...example }))),
  )
}

/**
 * Builds the root command from the contract roster: `task list` and
 * `task create` become subcommands of an auto-created `task` group.
 */
export const buildRoot = (
  binName: string,
  summary: string,
  contracts: ReadonlyArray<AnyContract>,
) => {
  const surfaces = contracts.map(surfaceOf)
  const groups = new Map<string, Array<CommandSurface>>()
  const topLevel: Array<CommandSurface> = []
  for (const surface of surfaces) {
    if (surface.path.length === 1) {
      topLevel.push(surface)
    } else if (surface.path.length === 2) {
      const group = groups.get(surface.path[0]!) ?? []
      group.push(surface)
      groups.set(surface.path[0]!, group)
    } else {
      throw new Error(`command paths deeper than two levels are not supported: "${surface.name}"`)
    }
  }

  const subcommands = [
    ...[...groups.entries()].map(([group, members]) =>
      Command.make(group).pipe(
        Command.withDescription(`${group} commands`),
        Command.withSubcommands(members.map(toCommand) as never),
      ),
    ),
    ...topLevel.map(toCommand),
  ]

  return Command.make(binName).pipe(
    Command.withDescription(summary),
    Command.withSubcommands(subcommands as never),
  )
}

/** Runs the root command against argv. The only Command.runWith call site. */
export const runRoot = (
  root: ReturnType<typeof buildRoot>,
  version: string,
  argv: ReadonlyArray<string>,
) => Command.runWith(root, { version })(argv)

/**
 * In machine formats, help text must never reach stdout: the formatter is
 * silenced (bin answers help with describe data) and whitespace-only console
 * writes from the parser runtime are dropped.
 */
const machineFormatterBase = CliOutput.defaultFormatter({ colors: false })

const quietConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
  log: (...args: ReadonlyArray<unknown>) => {
    if (args.every((arg) => typeof arg === "string" && arg.trim() === "")) {
      return
    }
    globalThis.console.log(...args)
  },
})

export const machineOutputLayer = (format: "json" | "ndjson"): Layer.Layer<never> => {
  const formatter: CliOutput.Formatter = {
    formatCliError: (error) => machineFormatterBase.formatCliError(error),
    formatError: (error) => machineFormatterBase.formatError(error),
    formatErrors: (errors) => machineFormatterBase.formatErrors(errors),
    formatHelpDoc: () => "",
    // --version follows the outcome protocol of the negotiated format.
    formatVersion: (name, cliVersion) =>
      format === "ndjson"
        ? JSON.stringify({ event: "summary", data: { name, version: cliVersion } })
        : JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            status: "ok",
            data: { name, version: cliVersion },
            warnings: [],
          }),
  }
  return Layer.mergeAll(CliOutput.layer(formatter), Layer.succeed(Console.Console, quietConsole))
}

/** Kit-owned classification of a failed run — bin.ts never sees parser types. */
export type RunFailure =
  | { readonly kind: "help"; readonly parseErrors: ReadonlyArray<AppErrorLike> }
  | { readonly kind: "usage"; readonly failure: AppErrorLike }
  | null

interface AppErrorLike {
  readonly message: string
  readonly fix?: string | undefined
}

/**
 * Deliberately no "did you mean" suggestions: fuzzy recovery hints cause
 * agents to make false correction attempts. Unknown input is a hard failure
 * with a deterministic discovery path (`describe`).
 */
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
    case "InvalidValue":
      return {
        message: `invalid value "${error.value}" for "${error.option}" — expected ${error.expected}`,
        fix: `pass a ${error.expected} value for "${error.option}"`,
      }
    case "UnknownSubcommand":
      return {
        message: `unknown command "${error.subcommand}"`,
        fix: `run ${binName} describe --json to list commands`,
      }
    case "UserError":
      return { message: error.message }
    case "ShowHelp":
      return { message: "help requested" }
  }
  // Unreachable: the switch is exhaustive over the closed CliError union.
  return { message: String(error) }
}

/** Translates parser errors into kit-owned failures; returns null for non-parser errors. */
export const classifyParserError = (error: unknown, binName: string): RunFailure => {
  if (error instanceof CliError.ShowHelp) {
    return error.errors.length === 0
      ? { kind: "help", parseErrors: [] }
      : {
          kind: "help",
          parseErrors: error.errors.map((parseError) => usageErrorFrom(parseError, binName)),
        }
  }
  if (CliError.isCliError(error)) {
    return { kind: "usage", failure: usageErrorFrom(error, binName) }
  }
  return null
}
