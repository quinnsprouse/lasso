import { Schema } from "effect"
import { ERROR_CATALOG } from "../errors.ts"

/**
 * The output protocol version. Bump only with a new envelope shape, and keep
 * emitting version "1" behind `--output-version=1` when you do.
 */
export const SCHEMA_VERSION = "1"

const ErrorBody = Schema.Struct({
  code: Schema.Literals(Object.keys(ERROR_CATALOG)),
  message: Schema.String,
  fix: Schema.optional(Schema.String),
  transient: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
})

export const OkEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  status: Schema.Literal("ok"),
  data: Schema.Unknown,
  warnings: Schema.Array(Schema.String),
})

export const ErrorEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  status: Schema.Literal("error"),
  error: ErrorBody,
  warnings: Schema.Array(Schema.String),
})

export const ConfirmationEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  status: Schema.Literal("confirmation_required"),
  plan: Schema.Unknown,
  confirmation: Schema.Struct({
    token: Schema.String,
    /** Canonical continuation as an argv array — never rely on shell quoting. */
    confirmArgs: Schema.Array(Schema.String),
    /** Convenience rendering of confirmArgs for humans. */
    confirmCommand: Schema.String,
  }),
  warnings: Schema.Array(Schema.String),
})

export type OkEnvelope = typeof OkEnvelope.Type
export type ErrorEnvelope = typeof ErrorEnvelope.Type
export type ConfirmationEnvelope = typeof ConfirmationEnvelope.Type

/**
 * NDJSON stream events. Zero or more `progress` events may precede the
 * terminal; every stream still ends with exactly one terminal event:
 * `summary`, `confirmation_required`, or `error`.
 */
const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export const ProgressEvent = Schema.Struct({
  event: Schema.Literal("progress"),
  /** Stable kebab-case key for the phase of work. */
  phase: Schema.String.pipe(Schema.check(Schema.isPattern(KEBAB_CASE))),
  message: Schema.NonEmptyString,
  completed: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  total: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
}).pipe(
  Schema.check(
    Schema.makeFilter((event: { completed?: number | undefined; total?: number | undefined }) => {
      if ((event.completed === undefined) !== (event.total === undefined)) {
        return "completed and total must appear together"
      }
      if (
        event.completed !== undefined &&
        event.total !== undefined &&
        event.completed > event.total
      ) {
        return "completed must be <= total"
      }
      return true
    }),
  ),
)

export type ProgressEvent = typeof ProgressEvent.Type

export const StreamEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("item"), data: Schema.Unknown }),
  Schema.Struct({ event: Schema.Literal("warning"), message: Schema.String }),
  ProgressEvent,
  Schema.Struct({ event: Schema.Literal("summary"), data: Schema.Unknown }),
  Schema.Struct({
    event: Schema.Literal("confirmation_required"),
    plan: Schema.Unknown,
    confirmation: Schema.Struct({
      token: Schema.String,
      confirmArgs: Schema.Array(Schema.String),
      confirmCommand: Schema.String,
    }),
  }),
  Schema.Struct({ event: Schema.Literal("error"), error: ErrorBody }),
])

export type StreamEvent = typeof StreamEvent.Type
