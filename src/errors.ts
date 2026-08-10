import { Schema } from "effect"
import { ExitCode } from "./output/exit.ts"

/**
 * Every expected failure in a command handler must be (or extend) `AppError`.
 * The handler type enforces this: an `Effect` whose error channel is not
 * `AppError` will not typecheck as a contract handler.
 *
 * `code` is the stable machine-readable identifier agents branch on.
 * `fix` is an exact recovery command or action, not prose.
 * `transient` tells an agent whether retrying is meaningful.
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
  (code: string, exit: ExitCode, transient: boolean) =>
  (init: ErrorInit): AppError =>
    new AppError({
      code,
      exit,
      transient,
      message: init.message,
      ...(init.fix !== undefined ? { fix: init.fix } : {}),
      ...(init.details !== undefined ? { details: init.details } : {}),
    })

/** Constructors for the error taxonomy. Add codes here, never inline. */
export const Errors = {
  usage: make("invalid_usage", ExitCode.usage, false),
  invalidData: make("invalid_data", ExitCode.invalidData, false),
  notFound: make("not_found", ExitCode.invalidData, false),
  conflict: make("resource_conflict", ExitCode.cannotWrite, false),
  cannotWrite: make("cannot_write", ExitCode.cannotWrite, false),
  serviceUnavailable: make("service_unavailable", ExitCode.serviceUnavailable, true),
  transient: make("transient_failure", ExitCode.transient, true),
  auth: make("auth_failure", ExitCode.auth, false),
  config: make("invalid_config", ExitCode.config, false),
  staleConfirmation: make("stale_confirmation", ExitCode.usage, false),
} as const

export type ErrorCode =
  | "invalid_usage"
  | "invalid_data"
  | "not_found"
  | "resource_conflict"
  | "cannot_write"
  | "service_unavailable"
  | "transient_failure"
  | "auth_failure"
  | "invalid_config"
  | "stale_confirmation"
  | "internal_error"
