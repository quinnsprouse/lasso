import { Schema } from "effect"
import type { ExitCode } from "./output/exit.ts"
import { ExitCode as Exit } from "./output/exit.ts"

/**
 * The error catalog: one table owns every error code, its exit code, and its
 * transience. Constructors, the ErrorCode type, describe output, and the
 * envelope all derive from it — adding a code here is the only way to add one.
 */
export const ERROR_CATALOG = {
  invalid_usage: { exit: Exit.usage, transient: false },
  invalid_data: { exit: Exit.invalidData, transient: false },
  not_found: { exit: Exit.invalidData, transient: false },
  resource_conflict: { exit: Exit.cannotWrite, transient: false },
  cannot_write: { exit: Exit.cannotWrite, transient: false },
  service_unavailable: { exit: Exit.serviceUnavailable, transient: true },
  transient_failure: { exit: Exit.transient, transient: true },
  auth_failure: { exit: Exit.auth, transient: false },
  invalid_config: { exit: Exit.config, transient: false },
  stale_confirmation: { exit: Exit.usage, transient: false },
  internal_error: { exit: Exit.internalDefect, transient: false },
} as const satisfies Record<string, { exit: ExitCode; transient: boolean }>

export type ErrorCode = keyof typeof ERROR_CATALOG

/**
 * Every expected failure in a command handler is an `AppError`, built through
 * `Errors.*` so code, exit, and transience always agree with the catalog.
 * `fix` is an exact recovery command or action, not prose. `transient` tells
 * an agent whether retrying is meaningful.
 */
export class AppError extends Schema.TaggedError<AppError>()("AppError", {
  code: Schema.String,
  message: Schema.String,
  fix: Schema.optional(Schema.String),
  transient: Schema.Boolean,
  exit: Schema.Int,
  details: Schema.optional(Schema.Unknown),
}) {}

interface ErrorInit {
  readonly message: string
  readonly fix?: string
  readonly details?: unknown
}

const make =
  (code: ErrorCode) =>
  (init: ErrorInit): AppError =>
    new AppError({
      code,
      exit: ERROR_CATALOG[code].exit,
      transient: ERROR_CATALOG[code].transient,
      message: init.message,
      ...(init.fix !== undefined ? { fix: init.fix } : {}),
      ...(init.details !== undefined ? { details: init.details } : {}),
    })

export const Errors = {
  usage: make("invalid_usage"),
  invalidData: make("invalid_data"),
  notFound: make("not_found"),
  conflict: make("resource_conflict"),
  cannotWrite: make("cannot_write"),
  serviceUnavailable: make("service_unavailable"),
  transient: make("transient_failure"),
  auth: make("auth_failure"),
  config: make("invalid_config"),
  staleConfirmation: make("stale_confirmation"),
} as const
