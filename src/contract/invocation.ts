// Global flag metadata for discovery and format negotiation.
// Keep this list aligned with the pinned parser when upgrading Effect.

export interface GlobalFlag {
  readonly cliName: string
  readonly alias?: string
  /** Takes a value (`--format json`, `--format=json`). */
  readonly value: boolean
  /** The accepted values, when the set is closed. */
  readonly values?: ReadonlyArray<string>
  readonly description: string
  /** Answers the invocation by itself: nothing after it needs to parse. */
  readonly terminal?: boolean
}

/** Parser-owned global flags, in the order `describe` lists them. */
export const GLOBAL_FLAGS: ReadonlyArray<GlobalFlag> = [
  { cliName: "--json", value: false, description: "Output a JSON envelope" },
  {
    cliName: "--format",
    value: true,
    values: ["auto", "json", "text", "ndjson"],
    description: "Output format: auto | json | text | ndjson",
  },
  {
    cliName: "--no-input",
    value: false,
    description:
      "Never wait for input (machine formats never prompt; only --wizard in text mode on a terminal does)",
  },
  {
    cliName: "--help",
    alias: "h",
    value: false,
    terminal: true,
    description: "In machine formats, answers with this describe payload",
  },
  {
    cliName: "--version",
    alias: "v",
    value: false,
    terminal: true,
    description: "CLI version (envelope or summary event)",
  },
  {
    cliName: "--log-level",
    value: true,
    values: ["all", "trace", "debug", "info", "warn", "warning", "error", "fatal", "none"],
    description: "Runtime log level (diagnostics go to stderr)",
  },
  {
    cliName: "--wizard",
    value: false,
    description: "Interactive wizard — text mode on a terminal only",
  },
  {
    cliName: "--completions",
    value: true,
    values: ["bash", "zsh", "fish", "sh"],
    terminal: true,
    description: "Print a shell completion script — text mode only",
  },
]

const globalByName = new Map<string, GlobalFlag>(
  GLOBAL_FLAGS.flatMap((flag) => [
    [flag.cliName, flag] as const,
    ...(flag.alias !== undefined ? [[`-${flag.alias}`, flag] as const] : []),
  ]),
)

/** Every spelling a contract param must not reuse. */
export const GLOBAL_FLAG_NAMES: ReadonlySet<string> = new Set(globalByName.keys())
export const GLOBAL_FLAG_ALIASES: ReadonlySet<string> = new Set(
  GLOBAL_FLAGS.flatMap((flag) => (flag.alias !== undefined ? [flag.alias] : [])),
)

/** The literals the parser accepts for a boolean flag's value. */
export const BOOLEAN_LITERALS: ReadonlySet<string> = new Set(
  "true yes on 1 y false no off 0 n".split(" "),
)

/** Splits `--flag=value` into its parts; `--flag` alone has no inline value. */
const splitInline = (token: string): readonly [string, string | undefined] =>
  token.includes("=")
    ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
    : [token, undefined]

/**
 * Checks every parser-owned global flag anywhere before a `--` terminator:
 * a value-taking flag must carry a valid value. Returns the reason or undefined.
 */
export const validateGlobalFlags = (args: ReadonlyArray<string>): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (token === "--") {
      break
    }
    const [name, inline] = splitInline(token)
    const global = globalByName.get(name)
    if (global === undefined || !global.value) {
      continue
    }
    const value = inline ?? args[i + 1]
    if (value === undefined || (inline === undefined && value.startsWith("-"))) {
      return `${name} needs a value`
    }
    if (global.values !== undefined && !global.values.includes(value)) {
      return `invalid value "${value}" for ${name}`
    }
    if (inline === undefined) {
      i += 1
    }
  }
  return undefined
}
