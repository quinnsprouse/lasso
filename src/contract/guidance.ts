import { isGuideTopic } from "../guides/catalog.ts"
import type { OutputMode } from "../output/format.ts"
import type { NextAction } from "../output/guidance.ts"
import { NEXT_LIMIT } from "../output/guidance.ts"
import type { Outcome } from "../output/outcome.ts"
import { BOOLEAN_LITERALS } from "./invocation.ts"
import { Effect } from "effect"

/** The reason an argv would fail against the surface, or undefined when it parses. */
export type Validate<R> = (
  args: ReadonlyArray<string>,
) => Effect.Effect<string | undefined, never, R>

/**
 * An outcome's point-of-use guidance, validated and bounded before it reaches
 * the wire.
 *
 * - Every `next` action must be a real invocation of this CLI (command path,
 *   declared flags, positional arity). Invalid ones are dropped and reported
 *   in `warnings`, never turned into a failure: a bad hint after a completed
 *   write must not make the write look failed. Tests assert empty warnings.
 * - Duplicates collapse; at most NEXT_LIMIT survive, in declaration order.
 * - Every `guides` id must exist in the catalog; unknown ids are dropped the
 *   same way (contracts cannot produce one — the GuideTopic union stops them —
 *   but a hand-built AppError could).
 */
export const finalizeGuidance = Effect.fn("finalizeGuidance")(function* <O extends Outcome, R>(
  validate: Validate<R>,
  outcome: O,
): Effect.fn.Return<O, never, R> {
  const warnings: Array<string> = []
  const next: Array<NextAction> = []
  const seen = new Set<string>()
  for (const action of outcome.next ?? []) {
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- argv serialization is a deduplication key
    const key = JSON.stringify(action.args)
    if (seen.has(key)) {
      continue
    }
    const reason = yield* validate(action.args)
    if (reason !== undefined) {
      warnings.push(`dropped next action "${action.message}": ${reason}`)
      continue
    }
    if (next.length >= NEXT_LIMIT) {
      warnings.push(`dropped next action "${action.message}": more than ${NEXT_LIMIT} next actions`)
      continue
    }
    seen.add(key)
    next.push(action)
  }
  const guides: Array<string> = []
  for (const topic of outcome.guides ?? []) {
    if (guides.includes(topic)) {
      continue
    }
    if (!isGuideTopic(topic)) {
      warnings.push(`dropped guide pointer "${topic}": no such topic`)
      continue
    }
    guides.push(topic)
  }
  return { ...outcome, next, guides, warnings: [...(outcome.warnings ?? []), ...warnings] }
})

/**
 * The invocation as a fresh preview: every mutation control removed, the
 * negotiated machine format kept. A re-plan, an interrupt, and a corrected
 * guess all offer this, so no generated move ever applies a change.
 */
export const previewArgs = (
  argv: ReadonlyArray<string>,
  format: OutputMode["format"],
): ReadonlyArray<string> =>
  withMachineFormat(
    withoutFlag(withoutFlag(withoutFlag(argv, "--confirm", true), "--yes"), "-y"),
    formatArgs(format),
  )

/** The machine-format flag a replay must carry so it stays machine-readable under a TTY. */
export const formatArgs = (format: "json" | "ndjson" | "text"): ReadonlyArray<string> =>
  format === "ndjson" ? ["--format", "ndjson"] : format === "json" ? ["--json"] : []

/**
 * argv with the machine-format flag inserted BEFORE any `--` terminator, so a
 * replay stays machine-readable under a TTY and the flag is never mistaken
 * for a positional value.
 */
export const withMachineFormat = (
  argv: ReadonlyArray<string>,
  machine: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const terminator = argv.indexOf("--")
  return terminator === -1
    ? [...argv, ...machine]
    : [...argv.slice(0, terminator), ...machine, ...argv.slice(terminator)]
}

/**
 * argv with the first occurrence of `token` before any `--` terminator
 * replaced by `replacement`. A flag token also matches its inline form
 * (`--stauts=all` → `--status=all`). Undefined when the token is absent.
 */
export const withReplacedToken = (
  argv: ReadonlyArray<string>,
  token: string,
  replacement: string,
): ReadonlyArray<string> | undefined => {
  const terminator = argv.indexOf("--")
  const at = (terminator === -1 ? argv : argv.slice(0, terminator)).findIndex(
    (arg) => arg === token || (token.startsWith("-") && arg.startsWith(`${token}=`)),
  )
  return at === -1 ? undefined : argv.with(at, `${replacement}${argv[at]!.slice(token.length)}`)
}

/**
 * argv with a control flag removed in every spelling the parser accepts:
 * `--flag`, `--flag=value`, `--no-flag`, and (for booleans) a following
 * literal such as `true`; a value-taking flag also drops its value.
 */
export const withoutFlag = (
  argv: ReadonlyArray<string>,
  flag: string,
  takesValue = false,
): ReadonlyArray<string> => {
  const negated = flag.startsWith("--") ? `--no-${flag.slice(2)}` : undefined
  const out: Array<string> = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      out.push(...argv.slice(i))
      break
    }
    if (arg === flag || arg === negated) {
      if (takesValue || (argv[i + 1] !== undefined && BOOLEAN_LITERALS.has(argv[i + 1]!))) {
        i += 1
      }
      continue
    }
    if (arg.startsWith(`${flag}=`)) {
      continue
    }
    out.push(arg)
  }
  return out
}
