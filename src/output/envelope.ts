import { Schema } from "effect"

/**
 * The output protocol version. Bump only with a new envelope shape, and keep
 * emitting version "1" behind `--output-version=1` when you do.
 */
export const SCHEMA_VERSION = "1"

const ErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  fix: Schema.optional(Schema.String),
  transient: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
})

export const OkEnvelope = Schema.Struct({
  schemaVersion: Schema.String,
  status: Schema.Literal("ok"),
  data: Schema.Unknown,
  warnings: Schema.Array(Schema.String),
})

export const ErrorEnvelope = Schema.Struct({
  schemaVersion: Schema.String,
  status: Schema.Literal("error"),
  error: ErrorBody,
  warnings: Schema.Array(Schema.String),
})

export const ConfirmationEnvelope = Schema.Struct({
  schemaVersion: Schema.String,
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

/** NDJSON stream events. Every stream ends with `summary` or `error`. */
export const StreamEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("item"), data: Schema.Unknown }),
  Schema.Struct({ event: Schema.Literal("warning"), message: Schema.String }),
  Schema.Struct({
    event: Schema.Literal("progress"),
    message: Schema.String,
    completed: Schema.optional(Schema.Int),
    total: Schema.optional(Schema.Int),
  }),
  Schema.Struct({ event: Schema.Literal("summary"), data: Schema.Unknown }),
  Schema.Struct({ event: Schema.Literal("error"), error: ErrorBody }),
])

export type StreamEvent = typeof StreamEvent.Type
