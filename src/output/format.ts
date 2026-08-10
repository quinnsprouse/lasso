/**
 * Format negotiation happens BEFORE command parsing so that even a parse
 * error can honor `--json`. This module is deliberately plain TypeScript:
 * it runs before the Effect runtime exists.
 */
type OutputFormat = "auto" | "json" | "text" | "ndjson"

export interface OutputMode {
  /** Resolved format: never "auto" after negotiation. */
  readonly format: "json" | "text" | "ndjson"
  /** True when every prompt must be refused rather than shown. */
  readonly noInput: boolean
  /** Color allowed (text mode only). */
  readonly color: boolean
  /** argv with the global output flags removed, ready for command parsing. */
  readonly argv: ReadonlyArray<string>
}

const FORMAT_VALUES: ReadonlyArray<OutputFormat> = ["auto", "json", "text", "ndjson"]

const isFormat = (value: string): value is OutputFormat =>
  (FORMAT_VALUES as ReadonlyArray<string>).includes(value)

export interface NegotiateOptions {
  readonly argv: ReadonlyArray<string>
  readonly stdoutIsTTY: boolean
  readonly stdinIsTTY: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * Precedence: explicit flag > env (`LASSO_FORMAT`) > auto-detection.
 * Auto selects JSON when stdout is not a terminal — the agent that forgot
 * `--json` still gets machine-readable output.
 */
export const negotiate = (options: NegotiateOptions): OutputMode => {
  const rest: Array<string> = []
  let format: OutputFormat | undefined
  let noInput = false
  let error: string | undefined

  const argv = options.argv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--json") {
      format = "json"
    } else if (arg === "--no-input") {
      noInput = true
    } else if (arg === "--format") {
      const value = argv[i + 1]
      if (value !== undefined && isFormat(value)) {
        format = value
        i++
      } else {
        error = value === undefined ? "missing value for --format" : `invalid format "${value}"`
      }
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length)
      if (isFormat(value)) {
        format = value
      } else {
        error = `invalid format "${value}"`
      }
    } else {
      rest.push(arg)
    }
  }

  const envFormat = options.env["LASSO_FORMAT"]
  if (format === undefined && envFormat !== undefined && isFormat(envFormat)) {
    format = envFormat
  }

  const resolved: "json" | "text" | "ndjson" =
    format === undefined || format === "auto" ? (options.stdoutIsTTY ? "text" : "json") : format

  const color =
    resolved === "text" &&
    options.stdoutIsTTY &&
    options.env["NO_COLOR"] === undefined &&
    options.env["TERM"] !== "dumb" &&
    options.env["CI"] === undefined

  const mode: OutputMode = {
    format: resolved,
    noInput: noInput || !options.stdinIsTTY || options.env["CI"] !== undefined,
    color,
    argv: rest,
  }

  if (error !== undefined) {
    throw new FormatNegotiationError(error, mode)
  }
  return mode
}

/** Carries the already-resolved mode so the error itself can be rendered in it. */
export class FormatNegotiationError extends Error {
  readonly mode: OutputMode

  constructor(message: string, mode: OutputMode) {
    super(message)
    this.name = "FormatNegotiationError"
    this.mode = mode
  }
}
