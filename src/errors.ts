import { Schema } from "effect"
import type { GuideTopic } from "./guides/catalog.generated.ts"
import type { ExitCode } from "./output/exit.ts"
import { ExitCode as Exit } from "./output/exit.ts"
import type { NextAction as NextActionType } from "./output/guidance.ts"
import { NextAction } from "./output/guidance.ts"

/**
 * The error catalog: one table owns every error code, its exit code, its
 * transience, and who raises it. Everything else derives from it: the
 * `Errors.*` factories (one per command-raised code, named after the code),
 * the `ErrorCode` type, exit mapping, and `describe` output. Adding a code
 * here is the only way to add one.
 */
export const ERROR_CATALOG = {
  invalid_usage: { exit: Exit.usage, transient: false, raisedBy: "command" },
  invalid_data: { exit: Exit.invalidData, transient: false, raisedBy: "command" },
  not_found: { exit: Exit.invalidData, transient: false, raisedBy: "command" },
  resource_conflict: { exit: Exit.cannotWrite, transient: false, raisedBy: "command" },
  cannot_write: { exit: Exit.cannotWrite, transient: false, raisedBy: "command" },
  service_unavailable: { exit: Exit.serviceUnavailable, transient: true, raisedBy: "command" },
  transient_failure: { exit: Exit.transient, transient: true, raisedBy: "command" },
  auth_failure: { exit: Exit.auth, transient: false, raisedBy: "command" },
  invalid_config: { exit: Exit.config, transient: false, raisedBy: "command" },
  stale_confirmation: { exit: Exit.usage, transient: false, raisedBy: "command" },
  /** A defect: a bug in the CLI, never an expected failure a handler raises. */
  internal_error: { exit: Exit.internalDefect, transient: false, raisedBy: "runtime" },
  /** SIGINT while running; the runtime alone produces it. */
  interrupted: { exit: Exit.interrupted, transient: true, raisedBy: "runtime" },
} as const satisfies Record<
  string,
  { exit: ExitCode; transient: boolean; raisedBy: "command" | "runtime" }
>

export type ErrorCode = keyof typeof ERROR_CATALOG

/** Codes a command handler may raise (the ones with an `Errors.*` factory). */
export type CommandErrorCode = {
  [C in ErrorCode]: (typeof ERROR_CATALOG)[C]["raisedBy"] extends "command" ? C : never
}[ErrorCode]

/**
 * Every expected failure in a command handler is an `AppError`, built through
 * `Errors.*` so code, exit, and transience always agree with the catalog.
 * `fix` is an exact recovery command or action, not prose — required by the
 * factory type and by the wire. `transient` tells an agent whether retrying
 * is meaningful. The runtime maps exit and transience from the catalog by
 * code, so a hand-built AppError cannot invent either.
 */
export class AppError extends Schema.TaggedError<AppError>()("AppError", {
  code: Schema.String,
  message: Schema.String,
  fix: Schema.String,
  transient: Schema.Boolean,
  exit: Schema.Int,
  details: Schema.optional(Schema.Unknown),
  /** Executable continuations (argv for this binary), importance-ordered, at most three. */
  next: Schema.optional(Schema.Array(NextAction)),
  /** Guide topics that build the model this failure assumes. Only for missing-MODEL failures. */
  guides: Schema.optional(Schema.Array(Schema.String)),
}) {}

export interface ErrorInit {
  readonly message: string
  /** Exact recovery command or action. Required: agents act on it mechanically. */
  readonly fix: string
  readonly details?: unknown
  /** The next move(s) as argv for this binary (no bin name), like confirmArgs. */
  readonly next?: ReadonlyArray<NextActionType>
  /**
   * Guide topics for a missing-MODEL failure (the agent needs to understand
   * something the surface cannot express). An error whose fix is complete
   * declares none of its own; it still inherits the command's topics.
   */
  readonly guides?: ReadonlyArray<GuideTopic>
}

const make =
  (code: ErrorCode) =>
  (init: ErrorInit): AppError =>
    new AppError({
      code,
      exit: ERROR_CATALOG[code].exit,
      transient: ERROR_CATALOG[code].transient,
      message: init.message,
      fix: init.fix,
      ...(init.details !== undefined ? { details: init.details } : {}),
      ...(init.next !== undefined ? { next: init.next } : {}),
      ...(init.guides !== undefined ? { guides: init.guides } : {}),
    })

/** `resource_conflict` → `resourceConflict`: the factory name is the code in camelCase. */
export const factoryName = (code: string): string =>
  code.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())

type FactoryName<C extends string> = C extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<FactoryName<Tail>>}`
  : C

type Factories = {
  readonly [C in CommandErrorCode as FactoryName<C>]: (init: ErrorInit) => AppError
}

/**
 * One factory per command-raised code, named after the code in camelCase
 * (`factoryName`). The invariants check this table against the catalog, so a
 * new command code without a factory here fails the Fast profile.
 */
export const Errors: Factories = {
  invalidUsage: make("invalid_usage"),
  invalidData: make("invalid_data"),
  notFound: make("not_found"),
  resourceConflict: make("resource_conflict"),
  cannotWrite: make("cannot_write"),
  serviceUnavailable: make("service_unavailable"),
  transientFailure: make("transient_failure"),
  authFailure: make("auth_failure"),
  invalidConfig: make("invalid_config"),
  staleConfirmation: make("stale_confirmation"),
}
