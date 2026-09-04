import type { CommandSurface } from "./surface.ts"

/**
 * The single owner of two facts the parser also knows: which global flags
 * exist (with their values), and what makes an argv a real invocation of
 * this CLI. `describe` lists the flags from here; `bin.ts` resolves the
 * command path with `resolveCommandPath`; the runtime validates every `next`
 * action, the guide invariants every fenced command, and the skill test
 * every router row with `validateInvocation`. One definition, so none of
 * them can name a command or flag the parser would reject.
 */

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

const isTerminal = (token: string): boolean =>
  globalByName.get(splitInline(token)[0])?.terminal === true

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

export interface CommandPath {
  /** The resolved command name (`"task create"`), or the group alone (`"task"`). */
  readonly named: string
  /** Index of the first token after the path. */
  readonly rest: number
  /** Why the path could not be resolved, when it could not. */
  readonly error?: string
}

/**
 * Resolves the command path from an argv: leading global flags are skipped
 * (with their values), then one or two tokens name a group and a leaf.
 * Fails on an unknown flag before the path, an invalid global value, or a
 * token that is neither a command nor a group.
 */
export const resolveCommandPath = (
  surfaces: ReadonlyArray<CommandSurface>,
  args: ReadonlyArray<string>,
): CommandPath => {
  const byName = new Set(surfaces.map((surface) => surface.name))
  const isGroup = (word: string) => surfaces.some((surface) => surface.name.startsWith(`${word} `))
  /** Consumes one global flag at `at`; returns the next index, or the reason it is invalid. */
  const consumeGlobal = (
    at: number,
  ): { readonly next: number; readonly terminal: boolean } | { readonly error: string } => {
    const [name, inline] = splitInline(args[at]!)
    const global = globalByName.get(name)
    if (global === undefined) {
      return { error: `unrecognized flag "${name}"` }
    }
    if (
      !global.value &&
      inline !== undefined &&
      !(global.terminal && BOOLEAN_LITERALS.has(inline))
    ) {
      return { error: `${name} takes no value` }
    }
    if (!global.value) {
      return { next: at + 1, terminal: global.terminal === true }
    }
    const value = inline ?? args[at + 1]
    if (value === undefined || (inline === undefined && value.startsWith("-"))) {
      return { error: `${name} needs a value` }
    }
    if (global.values !== undefined && !global.values.includes(value)) {
      return { error: `invalid value "${value}" for ${name}` }
    }
    return { next: at + (inline === undefined ? 2 : 1), terminal: global.terminal === true }
  }
  let i = 0
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "-") {
    const consumed = consumeGlobal(i)
    if ("error" in consumed) {
      return { named: "", rest: i, error: consumed.error }
    }
    if (consumed.terminal) {
      return { named: "", rest: args.length }
    }
    i = consumed.next
  }
  const path: Array<string> = []
  while (i < args.length && path.length < 2) {
    // A global flag may sit between the group and the leaf: `task --log-level debug create`.
    if (args[i]!.startsWith("-") && args[i] !== "-") {
      if (globalByName.get(splitInline(args[i]!)[0]) === undefined) {
        // A group takes no flags of its own; a leaf has not been named yet.
        if (path.length > 0 && !byName.has(path.join(" "))) {
          return {
            named: path.join(" "),
            rest: i,
            error: `unrecognized flag "${splitInline(args[i]!)[0]}"`,
          }
        }
        break
      }
      const consumed = consumeGlobal(i)
      if ("error" in consumed) {
        return { named: path.join(" "), rest: i, error: consumed.error }
      }
      if (consumed.terminal) {
        return { named: path.join(" "), rest: args.length }
      }
      i = consumed.next
      continue
    }
    const candidate = [...path, args[i]!].join(" ")
    if (byName.has(candidate) || isGroup(candidate)) {
      path.push(args[i]!)
      i += 1
      if (byName.has(candidate)) {
        break
      }
    } else {
      return {
        named: candidate,
        rest: i,
        error: `"${candidate}" is not a command`,
      }
    }
  }
  return { named: path.join(" "), rest: i }
}

/** Returns the reason the invocation is invalid, or undefined when it parses. */
export const validateInvocation = (
  surfaces: ReadonlyArray<CommandSurface>,
  args: ReadonlyArray<string>,
  options: { readonly allowMissingArguments?: boolean } = {},
): string | undefined => {
  const resolved = resolveCommandPath(surfaces, args)
  if (resolved.error !== undefined) {
    return resolved.error
  }
  const surface = surfaces.find((candidate) => candidate.name === resolved.named)
  if (surface === undefined) {
    // No leaf: only a terminal global flag (--help, --version) answers by itself.
    if (args.some(isTerminal)) {
      return undefined
    }
    return resolved.named.length === 0 ? "no command named" : `"${resolved.named}" is not a command`
  }

  const flags = new Map(
    surface.params
      .filter((param) => param.kind === "flag")
      .map((param) => [param.cliName, param] as const),
  )
  const aliases = new Map<string, (typeof surface.params)[number]>(
    surface.params
      .filter((param) => param.alias !== undefined)
      .map((param) => [`-${param.alias}`, param] as const),
  )
  const positional = surface.params.filter((param) => param.kind === "argument")
  const seen = new Set<string>()
  let positionals = 0
  for (let i = resolved.rest; i < args.length; i++) {
    const token = args[i]!
    if (token === "--") {
      positionals += args.length - i - 1
      break
    }
    if (!token.startsWith("-") || token === "-") {
      positionals += 1
      continue
    }
    const [name, inline] = splitInline(token)
    const global = globalByName.get(name)
    if (global !== undefined) {
      if (
        !global.value &&
        inline !== undefined &&
        !(global.terminal && BOOLEAN_LITERALS.has(inline))
      ) {
        return `${name} takes no value`
      }
      if (global.terminal && !global.value) {
        return undefined
      }
      if (global.value) {
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
      if (global.terminal) {
        return undefined
      }
      continue
    }
    const negated = name.startsWith("--no-")
      ? flags.get(`--${name.slice("--no-".length)}`)
      : undefined
    const param =
      flags.get(name) ?? aliases.get(name) ?? (negated?.type === "boolean" ? negated : undefined)
    if (param === undefined) {
      return `flag ${name} is not declared for "${surface.name}"`
    }
    if (param.type === "boolean") {
      if (negated !== undefined) {
        // `--no-flag` is a bare negation: the parser rejects any value on it.
        if (inline !== undefined) {
          return `negated flag ${name} takes no value`
        }
        continue
      }
      if (inline !== undefined && !BOOLEAN_LITERALS.has(inline)) {
        return `boolean flag ${name} takes true|false, got "${inline}"`
      }
      // The parser also accepts the literal as the next token: `--flag true`.
      if (inline === undefined && args[i + 1] !== undefined && BOOLEAN_LITERALS.has(args[i + 1]!)) {
        i += 1
      }
      continue
    }
    if (seen.has(param.cliName)) {
      return `flag ${param.cliName} was given more than once`
    }
    seen.add(param.cliName)
    let value = inline
    if (value === undefined) {
      value = args[i + 1]
      if (value === undefined || value.startsWith("-")) {
        return `${name} needs a value`
      }
      i += 1
    }
    if (param.type === "choice" && !(param.choices ?? []).includes(value)) {
      return `${name} must be one of ${(param.choices ?? []).join(" | ")}, got "${value}"`
    }
    if (param.type === "integer" && (value.trim() === "" || !Number.isInteger(Number(value)))) {
      return `${name} needs an integer, got "${value}"`
    }
  }
  if (!options.allowMissingArguments && positionals < positional.length) {
    return `"${surface.name}" needs ${positional.length} argument(s), got ${positionals}`
  }
  if (positionals > positional.length) {
    return `"${surface.name}" takes ${positional.length} argument(s), got ${positionals}`
  }
  return undefined
}
