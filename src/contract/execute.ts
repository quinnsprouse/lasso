import { Effect, Schema } from "effect"
import type { ErrorCode } from "../errors.ts"
import { AppError, Errors } from "../errors.ts"
import { DISCOVER } from "../output/guidance.ts"
import { SCHEMA_VERSION } from "../output/envelope.ts"
import { Renderer } from "../output/renderer.ts"
import type { AppServices } from "../services/index.ts"
import type { InputOf, MutationContract, ParamSpec, QueryContract } from "./contract.ts"
import { finalizeGuidance, formatArgs, withMachineFormat, withoutFlag } from "./guidance.ts"
import type { CommandSurface } from "./surface.ts"
import { canonicalJson, isPlanToken, planToken } from "./token.ts"

// Contract execution: what a parsed command does. The parser boundary
// (adapter.ts) hands each leaf its raw input and a validator for next moves.

type Input = InputOf<Record<string, ParamSpec>>

/** What the parser hands a leaf: every declared param, keyed by its contract key. */
export type RawInput = Readonly<Record<string, string | number | boolean | undefined>>

type Query = QueryContract<Record<string, ParamSpec>, unknown, AppServices>
type Mutation = MutationContract<
  Record<string, ParamSpec>,
  unknown,
  unknown,
  AppServices,
  AppServices
>

/** Control-flow signal: the outcome was already rendered; exit with this code. */
export class ExitSignal extends Schema.TaggedError<ExitSignal>()("ExitSignal", {
  code: Schema.Int,
}) {}

/** The reason an argv would fail against the surface, or undefined when it parses. */
export type Validate<R> = (
  args: ReadonlyArray<string>,
) => Effect.Effect<string | undefined, never, R>

/** Framework controls, split from domain input before any handler runs. */
interface Controls {
  readonly dryRun: boolean
  readonly confirm: string | undefined
  readonly yes: boolean
  readonly fields: string | undefined
}

export const validateControls = (controls: Controls): Effect.Effect<void, AppError> => {
  if (controls.dryRun && (controls.yes || controls.confirm !== undefined)) {
    return Effect.fail(
      Errors.invalidUsage({
        message: "--dry-run cannot be combined with --yes or --confirm",
        fix: "preview with --dry-run alone, then apply with --yes or --confirm",
        next: [DISCOVER],
      }),
    )
  }
  if (controls.confirm !== undefined && !isPlanToken(controls.confirm)) {
    return Effect.fail(
      Errors.invalidUsage({
        message: `"${controls.confirm}" is not a confirmation token`,
        fix: "replay confirmation.confirmArgs from the confirmation_required envelope verbatim",
        next: [DISCOVER],
      }),
    )
  }
  if (controls.yes && controls.confirm !== undefined) {
    return Effect.fail(
      Errors.invalidUsage({
        message: "--yes and --confirm are mutually exclusive",
        fix: "use --confirm <token> to apply a previewed plan, or --yes to skip the preview",
        next: [DISCOVER],
      }),
    )
  }
  return Effect.void
}

export const splitInput = (
  surface: CommandSurface,
  raw: RawInput,
): { readonly domain: Input; readonly controls: Controls } => {
  const framework = new Set(
    surface.params.filter((param) => param.owner === "framework").map((param) => param.key),
  )
  return {
    domain: Object.fromEntries(Object.entries(raw).filter(([key]) => !framework.has(key))),
    controls: {
      dryRun: raw["dryRun"] === true,
      confirm: typeof raw["confirm"] === "string" ? raw["confirm"] : undefined,
      yes: raw["yes"] === true,
      fields: typeof raw["fields"] === "string" ? raw["fields"] : undefined,
    },
  }
}

const encodeOutput = (
  name: string,
  schema: Schema.Codec<unknown, unknown>,
  data: unknown,
): Effect.Effect<unknown, AppError> =>
  Schema.encodeUnknownEffect(schema)(data).pipe(
    Effect.mapError((cause) =>
      Errors.invalidData({
        message: `output failed its declared schema: ${cause.message}`,
        fix: `this is a bug in "${name}": make its handler return data matching dataSchema`,
      }),
    ),
  )

// Checks against the declared inventory even for an empty collection, so a bad
// field fails the same way whether or not there is data.
const project = (
  inventory: ReadonlyArray<string>,
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: string,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, AppError> => {
  const wanted = [
    ...new Set(
      fields
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field.length > 0),
    ),
  ]
  const unknown = wanted.filter((field) => !inventory.includes(field))
  if (wanted.length === 0 || unknown.length > 0) {
    return Effect.fail(
      Errors.invalidUsage({
        message:
          wanted.length === 0
            ? "--fields requires at least one field name"
            : `unknown field(s): ${unknown.join(", ")}`,
        fix: `use fields from: ${inventory.join(", ")}`,
        next: [DISCOVER],
      }),
    )
  }
  return Effect.succeed(
    rows.map((row) => Object.fromEntries(wanted.map((field) => [field, row[field]]))),
  )
}

/** Plan failures under --confirm that mean the previewed state no longer holds. */
const STATE_CHANGED: ReadonlySet<string> = new Set<ErrorCode>([
  "resource_conflict",
  "not_found",
  "invalid_data",
])

/** A failure the contract raised inherits the command's guides unless it declares its own. */
const withCommandGuides =
  (surface: CommandSurface) =>
  (error: AppError): AppError =>
    error.guides !== undefined || surface.guides.length === 0
      ? error
      : error.withGuides(surface.guides)

export const runQuery = Effect.fn("runQuery")(function* <R>(
  surface: CommandSurface,
  contract: Query,
  raw: RawInput,
  validate: Validate<R>,
): Effect.fn.Return<void, AppError, AppServices | Renderer | R> {
  const renderer = yield* Renderer
  const { domain, controls } = splitInput(surface, raw)

  if (controls.fields !== undefined && renderer.mode.format === "text") {
    return yield* Errors.invalidUsage({
      message: "--fields projection requires a machine format",
      fix: "add --json or --format ndjson",
      next: [DISCOVER],
    })
  }

  const data = yield* contract.handler(domain).pipe(Effect.mapError(withCommandGuides(surface)))
  const encoded = yield* encodeOutput(surface.name, contract.dataSchema, data)
  // Success offers next moves; guides are reserved for decisions and failures.
  const guidance = yield* finalizeGuidance(validate, {
    next: contract.next?.({ input: domain, data }),
  })

  const collection = contract.collection
  if (collection === undefined) {
    return yield* renderer.emit({
      kind: "ok",
      data: encoded,
      ...(contract.renderText !== undefined ? { text: contract.renderText(data) } : {}),
      ...guidance,
    })
  }

  const rows = collection.items(encoded)
  const stray = rows.flatMap(Object.keys).find((key) => !collection.fields.includes(key))
  if (stray !== undefined) {
    return yield* Errors.invalidData({
      message: `collection row field "${stray}" is not in the declared fields inventory`,
      fix: `add "${stray}" to the collection.fields of "${surface.name}"`,
    })
  }
  if (controls.fields !== undefined) {
    const projected = yield* project(collection.fields, rows, controls.fields)
    return yield* renderer.emit({
      kind: "ok",
      data: { items: projected, count: projected.length },
      items: projected,
      ...guidance,
    })
  }
  return yield* renderer.emit({
    kind: "ok",
    data: encoded,
    items: rows,
    ...(contract.renderText !== undefined ? { text: contract.renderText(data) } : {}),
    ...guidance,
  })
})

export const runMutation = Effect.fn("runMutation")(function* <R>(
  surface: CommandSurface,
  contract: Mutation,
  raw: RawInput,
  validate: Validate<R>,
): Effect.fn.Return<void, AppError | ExitSignal, AppServices | Renderer | R> {
  const renderer = yield* Renderer
  const { domain, controls } = splitInput(surface, raw)

  yield* validateControls(controls)

  const original = renderer.mode.argv
  const machine = formatArgs(renderer.mode.format)
  /** The same invocation without --confirm: a fresh preview against current state. */
  const replan = withMachineFormat(withoutFlag(original, "--confirm", true), machine)
  const planned = contract.plan(domain).pipe(Effect.mapError(withCommandGuides(surface)))
  const rawPlan = yield* controls.confirm === undefined
    ? planned
    : planned.pipe(
        Effect.catch((cause) => {
          // Only a data failure means the previewed state is gone; a broken
          // environment (config, access, outage) keeps its own code and fix.
          if (!STATE_CHANGED.has(cause.code)) {
            return Effect.fail(cause)
          }
          const stale = Errors.staleConfirmation({
            message: `the previewed plan can no longer be produced: ${cause.message}`,
            fix: "re-run without --confirm to get a fresh plan",
            details: { code: cause.code },
            next: [{ message: "re-plan against the current state", args: replan }],
          })
          return Effect.fail(cause.guides === undefined ? stale : stale.withGuides(cause.guides))
        }),
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
  // Apply (and the human preview) receive the plan decoded from the exact
  // canonical JSON the token hashed, never the value plan returned: nothing
  // the schema or the wire drops can reach apply.
  const plan = yield* Schema.decodeEffect(Schema.fromJsonString(contract.planSchema))(
    canonicalJson(encodedPlan),
  ).pipe(
    Effect.mapError((cause) =>
      Errors.invalidData({
        message: `plan does not round-trip through its schema: ${cause.message}`,
        fix: `this is a bug in "${surface.name}": make planSchema encode and decode the plan losslessly`,
      }),
    ),
  )

  if (controls.dryRun) {
    // Preview-first: the next move is the confirmation flow, never a generated --yes.
    const guidance = yield* finalizeGuidance(validate, {
      next: [
        {
          message: "re-run without --dry-run to get a confirmation token",
          args: withMachineFormat(withoutFlag(original, "--dry-run"), machine),
        },
      ],
      guides: surface.guides,
    })
    return yield* renderer.emit({
      kind: "ok",
      data: { dryRun: true, plan: encodedPlan },
      ...(contract.renderPlanText !== undefined
        ? { text: `${contract.renderPlanText(plan)}\n(dry run — nothing was changed)` }
        : {}),
      ...guidance,
    })
  }

  if (controls.confirm !== undefined && controls.confirm !== token) {
    return yield* Errors.staleConfirmation({
      message:
        "the confirmation token does not match the current plan — state changed since the plan was produced",
      fix: "re-run without --confirm to get a fresh plan, then confirm with the new token",
      next: [{ message: "re-plan against the current state", args: replan }],
      ...(surface.guides.length > 0 ? { guides: surface.guides } : {}),
    })
  }

  if (controls.confirm === undefined && !controls.yes) {
    // The canonical continuation pins the machine format explicitly so a
    // replay under a TTY still produces machine output. Controls are
    // inserted BEFORE any -- terminator so the replay parses verbatim.
    const confirmArgs = withMachineFormat(original, [
      "--confirm",
      token,
      ...(machine.length > 0 ? machine : ["--json"]),
    ])
    const guidance = yield* finalizeGuidance(validate, {
      next: [{ message: "apply exactly this plan", args: confirmArgs }],
      guides: surface.guides,
    })
    yield* renderer.emit({
      kind: "confirmation",
      plan: encodedPlan,
      token,
      confirmArgs,
      ...(contract.renderPlanText !== undefined ? { text: contract.renderPlanText(plan) } : {}),
      ...guidance,
    })
    return yield* new ExitSignal({ code: 4 })
  }

  const data = yield* contract.apply(plan).pipe(Effect.mapError(withCommandGuides(surface)))
  const encoded = yield* encodeOutput(surface.name, contract.dataSchema, data)
  const guidance = yield* finalizeGuidance(validate, {
    next: contract.next?.({ input: domain, data }),
  })
  return yield* renderer.emit({
    kind: "ok",
    data: encoded,
    ...(contract.renderText !== undefined ? { text: contract.renderText(data) } : {}),
    ...guidance,
  })
})
