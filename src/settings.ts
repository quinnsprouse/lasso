import { Config, Duration, Effect } from "effect"
import type { AppError } from "./errors.ts"
import { Errors } from "./errors.ts"

/**
 * Every environment variable the CLI reads. `describe` publishes this table,
 * so an agent discovers settings the way it discovers flags.
 */
export const ENVIRONMENT = {
  format: {
    name: "LASSO_FORMAT",
    description: "Output format when no flag sets one: auto | json | text | ndjson",
    secret: false,
  },
  feedToken: {
    name: "LASSO_FEED_TOKEN",
    description: "Bearer token sent with task feed requests (task import)",
    secret: true,
  },
  httpTimeout: {
    name: "LASSO_HTTP_TIMEOUT",
    description: 'Time limit for one HTTP call, retries included, e.g. "10 seconds" (the default)',
    secret: false,
  },
} as const

/**
 * A setting read through Effect's Config, never `process.env`, so tests swap
 * values with a ConfigProvider. Read it where it is used, not while building a
 * layer: a malformed value then fails that one command as invalid_config, and
 * `describe` keeps working.
 */
const setting = <A>(
  config: Config.Config<A>,
  variable: { readonly name: string },
  expected: string,
): Effect.Effect<A, AppError> =>
  Effect.mapError(config, (cause) =>
    Errors.invalidConfig({
      message: `${variable.name} is not valid: ${cause.message}`,
      fix: `set ${variable.name} to ${expected}, or unset it`,
    }),
  )

/** Redacted: the token never prints in an envelope, a log, or an error. */
export const feedToken = setting(
  Config.option(Config.Redacted(ENVIRONMENT.feedToken.name)),
  ENVIRONMENT.feedToken,
  "the token the feed expects",
)

export const httpTimeout = setting(
  Config.Duration(ENVIRONMENT.httpTimeout.name).pipe(Config.withDefault(Duration.seconds(10))),
  ENVIRONMENT.httpTimeout,
  'a duration such as "10 seconds"',
)
