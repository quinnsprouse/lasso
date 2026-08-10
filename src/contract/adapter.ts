import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { AppError, Errors } from "../errors.ts"
import { Renderer } from "../output/renderer.ts"
import type {
  AnyContract,
  InputOf,
  MutationContract,
  ParamSpec,
  QueryContract,
} from "./contract.ts"
import { planToken } from "./token.ts"

/**
 * Maps CommandContracts onto the effect/unstable/cli parser. This adapter is
 * the only module that imports the parser — if the parser ever has to change,
 * only this file changes.
 */

export const kebabCase = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

/** Control-flow signal: rendering already happened, exit with this code. */
export class ExitSignal extends Schema.TaggedError<ExitSignal>()("ExitSignal", {
  code: Schema.Int,
}) {}

type Handled = Effect.Effect<void, AppError | ExitSignal, any>

const decorateFlag = <A>(flag: Flag.Flag<A>, spec: ParamSpec): Flag.Flag<A | undefined> => {
  const described = flag.pipe(Flag.withDescription(spec.description))
  const aliased = spec.alias === undefined ? described : described.pipe(Flag.withAlias(spec.alias))
  if (spec.default !== undefined) {
    return aliased.pipe(Flag.withDefault(spec.default as unknown as A))
  }
  return aliased.pipe(Flag.optional, Flag.map(Option.getOrUndefined))
}

const flagFor = (name: string, spec: ParamSpec): Flag.Flag<unknown> => {
  switch (spec.type) {
    case "boolean":
      // Booleans are presence flags: absent means false, never undefined.
      return Flag.boolean(name).pipe(Flag.withDescription(spec.description), (flag) =>
        spec.alias === undefined ? flag : flag.pipe(Flag.withAlias(spec.alias)),
      )
    case "integer":
      return decorateFlag(Flag.integer(name), spec)
    case "choice":
      return decorateFlag(Flag.choice(name, spec.choices ?? []), spec)
    case "path":
      return decorateFlag(Flag.path(name), spec)
    case "string":
      return decorateFlag(Flag.string(name), spec)
  }
}

const argumentFor = (name: string, spec: ParamSpec): Argument.Argument<unknown> => {
  switch (spec.type) {
    case "integer":
      return Argument.integer(name).pipe(Argument.withDescription(spec.description))
    case "choice":
      return Argument.choice(name, spec.choices ?? []).pipe(
        Argument.withDescription(spec.description),
      )
    case "path":
      return Argument.path(name).pipe(Argument.withDescription(spec.description))
    case "boolean":
    case "string":
      return Argument.string(name).pipe(Argument.withDescription(spec.description))
  }
}

const paramsFor = (contract: AnyContract): Record<string, unknown> => {
  const params: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(contract.params) as Array<[string, ParamSpec]>) {
    // Input keys are camelCase; the CLI surface is kebab-case.
    const cliName = kebabCase(key)
    params[key] = spec.kind === "argument" ? argumentFor(cliName, spec) : flagFor(cliName, spec)
  }
  if (contract.kind === "mutation") {
    params["dryRun"] = Flag.boolean("dry-run").pipe(
      Flag.withDescription("Render the execution plan without applying it"),
    )
    params["confirm"] = Flag.string("confirm").pipe(
      Flag.withDescription("Confirmation token from a previous run"),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    )
    params["yes"] = Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Apply without a separate confirmation step"),
    )
  } else if (contract.items !== undefined) {
    params["fields"] = Flag.string("fields").pipe(
      Flag.withDescription("Comma-separated projection of item fields"),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    )
  }
  return params
}

const project = (
  items: ReadonlyArray<Record<string, unknown>>,
  fields: string,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, AppError> => {
  const wanted = fields
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
  const available = new Set(items.flatMap((item) => Object.keys(item)))
  const unknown = wanted.filter((f) => !available.has(f))
  if (items.length > 0 && unknown.length > 0) {
    return Effect.fail(
      Errors.usage({
        message: `unknown field(s): ${unknown.join(", ")}`,
        fix: `use fields from: ${[...available].toSorted().join(", ")}`,
      }),
    )
  }
  return Effect.succeed(items.map((item) => Object.fromEntries(wanted.map((f) => [f, item[f]]))))
}

const runQuery = (
  contract: QueryContract<any, any, any>,
  input: Record<string, unknown>,
): Handled =>
  Effect.gen(function* () {
    const renderer = yield* Renderer
    const data = yield* contract.handler(input as InputOf<any>)
    const encoded = yield* Schema.encodeUnknownEffect(contract.output)(data).pipe(
      Effect.mapError((cause) =>
        Errors.invalidData({
          message: `output failed its declared schema: ${cause.message}`,
        }),
      ),
    )
    let items = contract.items?.(data)
    const fields = input["fields"]
    const projected = items !== undefined && typeof fields === "string"
    if (items !== undefined && typeof fields === "string") {
      items = yield* project(items, fields)
    }
    yield* renderer
      .ok({
        data: projected ? { items, count: items!.length } : encoded,
        ...(contract.render !== undefined ? { text: contract.render(data) } : {}),
        ...(items !== undefined ? { items } : {}),
      })
      .pipe(Effect.orDie)
  })

const runMutation = (
  contract: MutationContract<any, any, any, any>,
  input: Record<string, unknown>,
  commandPath: ReadonlyArray<string>,
): Handled =>
  Effect.gen(function* () {
    const renderer = yield* Renderer
    const plan = yield* contract.plan(input as InputOf<any>)
    const encodedPlan = yield* Schema.encodeUnknownEffect(contract.planSchema)(plan).pipe(
      Effect.mapError((cause) =>
        Errors.invalidData({ message: `plan failed its declared schema: ${cause.message}` }),
      ),
    )
    const token = planToken(encodedPlan)
    const dryRun = input["dryRun"] === true
    const confirm = input["confirm"]
    const yes = input["yes"] === true

    if (dryRun) {
      yield* renderer
        .ok({
          data: { dryRun: true, plan: encodedPlan },
          ...(contract.renderPlan !== undefined
            ? { text: `${contract.renderPlan(plan)}\n(dry run — nothing was changed)` }
            : {}),
        })
        .pipe(Effect.orDie)
      return
    }

    if (typeof confirm === "string") {
      if (confirm !== token) {
        return yield* Errors.staleConfirmation({
          message:
            "the confirmation token does not match the current plan — state changed since the plan was produced",
          fix: `re-run without --confirm to get a fresh plan, then confirm with the new token`,
        })
      }
    } else if (!yes) {
      const confirmArgs = [...renderer.mode.argv, "--confirm", token]
      yield* renderer
        .confirmation({
          plan: encodedPlan,
          token,
          confirmArgs,
          ...(contract.renderPlan !== undefined ? { text: contract.renderPlan(plan) } : {}),
        })
        .pipe(Effect.orDie)
      return yield* new ExitSignal({ code: 4 })
    }

    const data = yield* contract.apply(plan, input as InputOf<any>)
    const encoded = yield* Schema.encodeUnknownEffect(contract.output)(data).pipe(
      Effect.mapError((cause) =>
        Errors.invalidData({ message: `output failed its declared schema: ${cause.message}` }),
      ),
    )
    yield* renderer
      .ok({
        data: encoded,
        ...(contract.render !== undefined ? { text: contract.render(data) } : {}),
      })
      .pipe(Effect.orDie)
    void commandPath
  })

const leafName = (contract: AnyContract): string => {
  const parts = contract.name.split(" ")
  return parts[parts.length - 1]!
}

const toCommand = (contract: AnyContract) => {
  const handler = (input: Record<string, unknown>): Handled =>
    contract.kind === "mutation"
      ? runMutation(contract, input, contract.name.split(" "))
      : runQuery(contract, input)

  return Command.make(leafName(contract), paramsFor(contract) as never, handler as never).pipe(
    Command.withDescription(contract.summary),
    Command.withExamples(
      contract.examples.map(({ command, description }) => ({ command, description })),
    ),
  )
}

/**
 * Builds the root command from the registry: `task list` and `task create`
 * become subcommands of an auto-created `task` group.
 */
export const buildRoot = (
  binName: string,
  summary: string,
  contracts: ReadonlyArray<AnyContract>,
) => {
  const groups = new Map<string, Array<AnyContract>>()
  const topLevel: Array<AnyContract> = []
  for (const contract of contracts) {
    const parts = contract.name.split(" ")
    if (parts.length === 1) {
      topLevel.push(contract)
    } else if (parts.length === 2) {
      const group = groups.get(parts[0]!) ?? []
      group.push(contract)
      groups.set(parts[0]!, group)
    } else {
      throw new Error(`command paths deeper than two levels are not supported: "${contract.name}"`)
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
