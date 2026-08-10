import type { Effect, Schema } from "effect"
import type { AppError, ErrorCode } from "../errors.ts"

/**
 * The CommandContract is the single source of truth for the CLI surface.
 * Everything else — the parser, help, `describe`, JSON Schema, docs — is
 * generated from or validated against its normalized form (see surface.ts).
 *
 * Mutations are structurally plan → confirm → apply: `plan` derives a
 * self-contained execution plan (no side effects), `apply` receives ONLY the
 * confirmed plan. Anything that changes what apply does must live in the
 * plan, because the confirmation token binds the plan and nothing else.
 */

interface ParamBase {
  readonly description: string
}

/**
 * Arguments are positional and required; no alias, no default. The `never`
 * fields make invalid combinations unrepresentable even under generic
 * inference, where excess-property checks do not apply.
 */
type ArgumentSpec = ParamBase & {
  readonly alias?: never
  readonly default?: never
} & (
    | { readonly kind: "argument"; readonly type: "string"; readonly choices?: never }
    | { readonly kind: "argument"; readonly type: "integer"; readonly choices?: never }
    | { readonly kind: "argument"; readonly type: "path"; readonly choices?: never }
    | {
        readonly kind: "argument"
        readonly type: "choice"
        readonly choices: readonly [string, ...Array<string>]
      }
  )

/** Boolean flags are presence flags — no default (absent means false). */
type FlagSpec = ParamBase &
  (
    | {
        readonly kind: "flag"
        readonly type: "boolean"
        readonly alias?: string
        readonly default?: never
        readonly choices?: never
      }
    | {
        readonly kind: "flag"
        readonly type: "string"
        readonly alias?: string
        readonly default?: string
        readonly choices?: never
      }
    | {
        readonly kind: "flag"
        readonly type: "path"
        readonly alias?: string
        readonly default?: string
        readonly choices?: never
      }
    | {
        readonly kind: "flag"
        readonly type: "integer"
        readonly alias?: string
        readonly default?: number
        readonly choices?: never
      }
    | {
        readonly kind: "flag"
        readonly type: "choice"
        readonly alias?: string
        readonly choices: readonly [string, ...Array<string>]
        readonly default?: string
      }
  )

export type ParamSpec = ArgumentSpec | FlagSpec

interface Example {
  readonly command: string
  readonly description: string
}

type ParamValue<S extends ParamSpec> = S extends { readonly type: "boolean" }
  ? boolean
  : S extends { readonly type: "integer" }
    ? number
    : S extends { readonly choices: readonly (infer C extends string)[] }
      ? C
      : string

/** Arguments and defaulted/boolean flags are always present; other flags may be absent. */
export type InputOf<P extends Record<string, ParamSpec>> = {
  readonly [K in keyof P]: P[K] extends { readonly kind: "argument" }
    ? ParamValue<P[K]>
    : P[K] extends { readonly default: string | number }
      ? ParamValue<P[K]>
      : P[K] extends { readonly type: "boolean" }
        ? boolean
        : ParamValue<P[K]> | undefined
}

type Idempotency =
  | { readonly kind: "always" }
  | { readonly kind: "conditional"; readonly parameter: string }
  | { readonly kind: "none" }

interface ContractBase<P extends Record<string, ParamSpec>> {
  /** Space-separated command path, e.g. "task list". Two levels max. */
  readonly name: string
  readonly summary: string
  readonly stability: "stable" | "experimental"
  readonly params: P
  /** Domain error codes this command can produce. Framework codes are added automatically. */
  readonly domainErrorCodes: ReadonlyArray<ErrorCode>
  readonly examples: ReadonlyArray<Example>
}

interface Collection {
  /** The projectable field inventory — static, never derived from data. */
  readonly fields: readonly [string, ...Array<string>]
  /** Extracts rows from the ENCODED output, so JSON and NDJSON agree. */
  readonly items: (encoded: unknown) => ReadonlyArray<Record<string, unknown>>
}

export interface QueryContract<
  P extends Record<string, ParamSpec> = Record<string, ParamSpec>,
  A = unknown,
  R = never,
> extends ContractBase<P> {
  readonly kind: "query"
  readonly dataSchema: Schema.Codec<A, unknown>
  readonly handler: (input: InputOf<P>) => Effect.Effect<A, AppError, R>
  /** Human rendering for text mode; JSON pretty-print when omitted. */
  readonly renderText?: (data: A) => string
  /** Declare for collection outputs: enables NDJSON item events and --fields. */
  readonly collection?: Collection
}

export interface MutationContract<
  P extends Record<string, ParamSpec> = Record<string, ParamSpec>,
  Plan = unknown,
  A = unknown,
  RPlan = never,
  RApply = never,
> extends ContractBase<P> {
  readonly kind: "mutation"
  readonly dataSchema: Schema.Codec<A, unknown>
  readonly planSchema: Schema.Codec<Plan, unknown>
  readonly idempotency: Idempotency
  /**
   * Pure derivation of intent: validate input, read state, produce a
   * SELF-CONTAINED plan. Runs with read capabilities only.
   */
  readonly plan: (input: InputOf<P>) => Effect.Effect<Plan, AppError, RPlan>
  /** Executes exactly the confirmed plan. Never sees the original input. */
  readonly apply: (plan: Plan) => Effect.Effect<A, AppError, RApply>
  readonly renderText?: (data: A) => string
  readonly renderPlanText?: (plan: Plan) => string
}

// biome-ignore format: readability
export type AnyContract =
  | QueryContract<any, any, any>
  | MutationContract<any, any, any, any, any>

export interface Capabilities {
  readonly mutates: boolean
  readonly supportsDryRun: boolean
  readonly idempotency: Idempotency
  readonly interactive: boolean
  readonly mcpEligible: boolean
}

export const capabilitiesOf = (contract: AnyContract): Capabilities =>
  contract.kind === "mutation"
    ? {
        mutates: true,
        supportsDryRun: true,
        idempotency: contract.idempotency,
        interactive: false,
        mcpEligible: true,
      }
    : {
        mutates: false,
        supportsDryRun: false,
        idempotency: { kind: "always" },
        interactive: false,
        mcpEligible: true,
      }

export const defineQuery = <const P extends Record<string, ParamSpec>, A, R = never>(
  contract: Omit<QueryContract<P, A, R>, "kind">,
): QueryContract<P, A, R> => ({ kind: "query", ...contract })

export const defineMutation = <
  const P extends Record<string, ParamSpec>,
  Plan,
  A,
  RPlan = never,
  RApply = never,
>(
  contract: Omit<MutationContract<P, Plan, A, RPlan, RApply>, "kind">,
): MutationContract<P, Plan, A, RPlan, RApply> => ({ kind: "mutation", ...contract })
