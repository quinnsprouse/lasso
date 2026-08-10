import type { Effect, Schema } from "effect"
import type { AppError, ErrorCode } from "../errors.ts"

/**
 * The CommandContract is the single source of truth for the CLI surface.
 * Everything else — the parser, help, `describe`, JSON Schema, docs, the
 * agent skill, MCP tools — is generated from or validated against it.
 *
 * Mutations are structurally split into `plan` and `apply`: the runtime owns
 * `--dry-run`, the exit-4 confirmation protocol, and `--yes`. A command
 * cannot opt out of them, because the shape of the contract requires a plan.
 */

type ParamType = "string" | "boolean" | "integer" | "choice" | "path"

export interface ParamSpec {
  readonly kind: "flag" | "argument"
  readonly type: ParamType
  readonly description: string
  /** Single-character alias, flags only. */
  readonly alias?: string
  /** Flags with a default are always present in the input. */
  readonly default?: string | number | boolean
  /** Choice values; required when type is "choice". */
  readonly choices?: ReadonlyArray<string>
}

interface Example {
  readonly command: string
  readonly description: string
}

type ParamValue<S extends ParamSpec> = S["type"] extends "boolean"
  ? boolean
  : S["type"] extends "integer"
    ? number
    : S["choices"] extends ReadonlyArray<infer C extends string>
      ? C
      : string

type HasDefault<S extends ParamSpec> = S["default"] extends string | number | boolean ? true : false

/** Arguments and defaulted/boolean flags are always present; other flags may be absent. */
export type InputOf<P extends Record<string, ParamSpec>> = {
  readonly [K in keyof P]: P[K]["kind"] extends "argument"
    ? ParamValue<P[K]>
    : HasDefault<P[K]> extends true
      ? ParamValue<P[K]>
      : P[K]["type"] extends "boolean"
        ? boolean
        : ParamValue<P[K]> | undefined
}

interface ContractBase<P extends Record<string, ParamSpec>> {
  /** Space-separated command path, e.g. "task list". */
  readonly name: string
  readonly summary: string
  readonly stability: "stable" | "experimental"
  readonly params: P
  /** Error codes this command can produce — surfaced in describe and docs. */
  readonly errorCodes: ReadonlyArray<ErrorCode>
  readonly examples: ReadonlyArray<Example>
}

export interface QueryContract<
  P extends Record<string, ParamSpec> = Record<string, ParamSpec>,
  A = unknown,
  R = never,
> extends ContractBase<P> {
  readonly kind: "query"
  readonly output: Schema.Codec<A, unknown>
  readonly handler: (input: InputOf<P>) => Effect.Effect<A, AppError, R>
  /** Human rendering for text mode; JSON pretty-print when omitted. */
  readonly render?: (data: A) => string
  /** Collection accessor: enables NDJSON item streaming and `--fields`. */
  readonly items?: (data: A) => ReadonlyArray<Record<string, unknown>>
}

export interface MutationContract<
  P extends Record<string, ParamSpec> = Record<string, ParamSpec>,
  Plan = unknown,
  A = unknown,
  R = never,
> extends ContractBase<P> {
  readonly kind: "mutation"
  readonly output: Schema.Codec<A, unknown>
  readonly planSchema: Schema.Codec<Plan, unknown>
  readonly idempotent: boolean
  /** Pure derivation of intent: validate input, read state, produce a plan. Never mutates. */
  readonly plan: (input: InputOf<P>) => Effect.Effect<Plan, AppError, R>
  /** Executes exactly the given plan. The runtime guarantees the plan was confirmed. */
  readonly apply: (plan: Plan, input: InputOf<P>) => Effect.Effect<A, AppError, R>
  readonly render?: (data: A) => string
  readonly renderPlan?: (plan: Plan) => string
}

export type AnyContract = QueryContract<any, any, any> | MutationContract<any, any, any, any>

export interface Capabilities {
  readonly mutates: boolean
  readonly supportsDryRun: boolean
  readonly idempotent: boolean
  readonly interactive: boolean
  readonly mcpEligible: boolean
}

export const capabilitiesOf = (contract: AnyContract): Capabilities =>
  contract.kind === "mutation"
    ? {
        mutates: true,
        supportsDryRun: true,
        idempotent: contract.idempotent,
        interactive: false,
        mcpEligible: true,
      }
    : {
        mutates: false,
        supportsDryRun: false,
        idempotent: true,
        interactive: false,
        mcpEligible: true,
      }

export const defineQuery = <const P extends Record<string, ParamSpec>, A, R = never>(
  contract: Omit<QueryContract<P, A, R>, "kind">,
): QueryContract<P, A, R> => ({ kind: "query", ...contract })

export const defineMutation = <const P extends Record<string, ParamSpec>, Plan, A, R = never>(
  contract: Omit<MutationContract<P, Plan, A, R>, "kind">,
): MutationContract<P, Plan, A, R> => ({ kind: "mutation", ...contract })
