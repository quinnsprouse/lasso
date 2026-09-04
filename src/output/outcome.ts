import type { OutputMode } from "./format.ts"
import { SCHEMA_VERSION } from "./envelope.ts"
import type { NextAction } from "./guidance.ts"

/**
 * The outcome algebra: every invocation ends in exactly one of these, and
 * `renderOutcome` is the only definition of what each looks like on the wire
 * in each format. Both the Renderer service (in-Effect) and the process
 * boundary (bin.ts) render through this module; the parser adapter's marked
 * `--version` line is the only stdout write that does not.
 *
 * Every outcome may carry point-of-use guidance (`next`, `guides`); the
 * wire always shows both, empty when absent.
 */

interface WithGuidance {
  readonly next?: ReadonlyArray<NextAction> | undefined
  readonly guides?: ReadonlyArray<string> | undefined
  readonly warnings?: ReadonlyArray<string> | undefined
}

export type Outcome =
  | ({
      readonly kind: "ok"
      readonly data: unknown
      readonly text?: string | undefined
      readonly items?: ReadonlyArray<Record<string, unknown>> | undefined
    } & WithGuidance)
  | ({
      readonly kind: "confirmation"
      readonly plan: unknown
      readonly token: string
      readonly confirmArgs: ReadonlyArray<string>
      readonly text?: string | undefined
    } & WithGuidance)
  | ({
      readonly kind: "failure"
      readonly code: string
      readonly message: string
      readonly fix: string
      readonly transient: boolean
      readonly details?: unknown
    } & WithGuidance)

export interface Write {
  readonly stream: "stdout" | "stderr"
  readonly text: string
}

/** `confirmArgs` is the canonical form; the command string is display-only. */
const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`

const errorBody = (outcome: Extract<Outcome, { kind: "failure" }>) => ({
  code: outcome.code,
  message: outcome.message,
  fix: outcome.fix,
  transient: outcome.transient,
  ...(outcome.details !== undefined ? { details: outcome.details } : {}),
})

const guidance = (outcome: Outcome) => ({
  next: outcome.next ?? [],
  guides: outcome.guides ?? [],
})

/** Text-mode guidance: fixed prefixes so humans and agents read one vocabulary. */
const guidanceLines = (binName: string, outcome: Outcome): ReadonlyArray<string> => {
  const { next, guides } = guidance(outcome)
  return [
    ...next.map(
      (action) => `next: ${action.message}: ${[binName, ...action.args.map(shellQuote)].join(" ")}`,
    ),
    ...guides.map((topic) => `guide: ${binName} guide get ${topic}`),
  ]
}

const warningWrites = (mode: OutputMode, warnings: ReadonlyArray<string>): ReadonlyArray<Write> =>
  mode.format === "ndjson"
    ? warnings.map((message) => ({
        stream: "stdout",
        text: jsonLine({ event: "warning", message }),
      }))
    : mode.format === "text"
      ? warnings.map((warning) => ({ stream: "stderr", text: `warning: ${warning}\n` }))
      : []

export const renderOutcome = (
  mode: OutputMode,
  binName: string,
  outcome: Outcome,
): ReadonlyArray<Write> => {
  const warnings = outcome.warnings ?? []
  switch (outcome.kind) {
    case "ok": {
      if (mode.format === "ndjson") {
        const events =
          outcome.items !== undefined
            ? [
                ...outcome.items.map((data) => ({ event: "item", data })),
                { event: "summary", data: { count: outcome.items.length }, ...guidance(outcome) },
              ]
            : [{ event: "summary", data: outcome.data, ...guidance(outcome) }]
        return [
          ...warningWrites(mode, warnings),
          ...events.map((event): Write => ({ stream: "stdout", text: jsonLine(event) })),
        ]
      }
      if (mode.format === "text") {
        const lines = guidanceLines(binName, outcome)
        const body = outcome.text ?? JSON.stringify(outcome.data, null, 2)
        return [
          ...warningWrites(mode, warnings),
          {
            stream: "stdout",
            text: `${body}\n${lines.length > 0 ? `${lines.join("\n")}\n` : ""}`,
          },
        ]
      }
      return [
        {
          stream: "stdout",
          text: jsonLine({
            schemaVersion: SCHEMA_VERSION,
            status: "ok",
            data: outcome.data,
            warnings,
            ...guidance(outcome),
          }),
        },
      ]
    }

    case "confirmation": {
      const confirmCommand = [binName, ...outcome.confirmArgs.map(shellQuote)].join(" ")
      const confirmation = {
        token: outcome.token,
        confirmArgs: outcome.confirmArgs,
        confirmCommand,
      }
      if (mode.format === "ndjson") {
        return [
          ...warningWrites(mode, warnings),
          {
            stream: "stdout",
            text: jsonLine({
              event: "confirmation_required",
              plan: outcome.plan,
              confirmation,
              ...guidance(outcome),
            }),
          },
        ]
      }
      if (mode.format === "text") {
        const body = outcome.text ?? JSON.stringify(outcome.plan, null, 2)
        // The replay is always shown, then any further guidance beyond it.
        const lines = guidanceLines(binName, {
          ...outcome,
          next: (outcome.next ?? []).filter(
            (action) => JSON.stringify(action.args) !== JSON.stringify(outcome.confirmArgs),
          ),
        })
        return [
          ...warningWrites(mode, warnings),
          {
            stream: "stderr",
            text: `${body}\n\nThis change needs confirmation. Re-run with:\n  ${confirmCommand}\n${lines.length > 0 ? `${lines.join("\n")}\n` : ""}`,
          },
        ]
      }
      return [
        {
          stream: "stdout",
          text: jsonLine({
            schemaVersion: SCHEMA_VERSION,
            status: "confirmation_required",
            plan: outcome.plan,
            confirmation,
            warnings,
            ...guidance(outcome),
          }),
        },
      ]
    }

    case "failure": {
      if (mode.format === "ndjson") {
        return [
          ...warningWrites(mode, warnings),
          {
            stream: "stdout",
            text: jsonLine({ event: "error", error: errorBody(outcome), ...guidance(outcome) }),
          },
        ]
      }
      if (mode.format === "text") {
        const red = (text: string) => (mode.color ? `\u001b[31m${text}\u001b[0m` : text)
        const lines = [`${red("error:")} ${outcome.message}`, `fix: ${outcome.fix}`]
        if (outcome.transient) {
          lines.push("note: this failure is transient — retrying may work")
        }
        lines.push(...guidanceLines(binName, outcome))
        return [
          ...warningWrites(mode, warnings),
          { stream: "stderr", text: `${lines.join("\n")}\n` },
        ]
      }
      return [
        {
          stream: "stdout",
          text: jsonLine({
            schemaVersion: SCHEMA_VERSION,
            status: "error",
            error: errorBody(outcome),
            warnings,
            ...guidance(outcome),
          }),
        },
      ]
    }
  }
}
