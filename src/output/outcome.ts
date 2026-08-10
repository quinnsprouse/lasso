import type { OutputMode } from "./format.ts"
import { SCHEMA_VERSION } from "./envelope.ts"

/**
 * The outcome algebra: every invocation ends in exactly one of these, and
 * `renderOutcome` is the only definition of what each looks like on the wire
 * in each format. Both the Renderer service (in-Effect) and the process
 * boundary (bin.ts) render through this module — nothing else writes output.
 */

export type Outcome =
  | {
      readonly kind: "ok"
      readonly data: unknown
      readonly text?: string | undefined
      readonly items?: ReadonlyArray<Record<string, unknown>> | undefined
      readonly warnings?: ReadonlyArray<string> | undefined
    }
  | {
      readonly kind: "confirmation"
      readonly plan: unknown
      readonly token: string
      readonly confirmArgs: ReadonlyArray<string>
      readonly text?: string | undefined
    }
  | {
      readonly kind: "failure"
      readonly code: string
      readonly message: string
      readonly fix?: string | undefined
      readonly transient: boolean
      readonly details?: unknown
    }

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
  ...(outcome.fix !== undefined ? { fix: outcome.fix } : {}),
  transient: outcome.transient,
  ...(outcome.details !== undefined ? { details: outcome.details } : {}),
})

export const renderOutcome = (
  mode: OutputMode,
  binName: string,
  outcome: Outcome,
): ReadonlyArray<Write> => {
  switch (outcome.kind) {
    case "ok": {
      const warnings = outcome.warnings ?? []
      if (mode.format === "ndjson") {
        const events =
          outcome.items !== undefined
            ? [
                ...warnings.map((message) => ({ event: "warning", message })),
                ...outcome.items.map((data) => ({ event: "item", data })),
                { event: "summary", data: { count: outcome.items.length } },
              ]
            : [
                ...warnings.map((message) => ({ event: "warning", message })),
                { event: "summary", data: outcome.data },
              ]
        return events.map((event) => ({ stream: "stdout", text: jsonLine(event) }))
      }
      if (mode.format === "text") {
        return [
          ...warnings.map(
            (warning): Write => ({ stream: "stderr", text: `warning: ${warning}\n` }),
          ),
          {
            stream: "stdout",
            text: `${outcome.text ?? JSON.stringify(outcome.data, null, 2)}\n`,
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
          {
            stream: "stdout",
            text: jsonLine({ event: "confirmation_required", plan: outcome.plan, confirmation }),
          },
        ]
      }
      if (mode.format === "text") {
        const body = outcome.text ?? JSON.stringify(outcome.plan, null, 2)
        return [
          {
            stream: "stderr",
            text: `${body}\n\nThis change needs confirmation. Re-run with:\n  ${confirmCommand}\n`,
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
            warnings: [],
          }),
        },
      ]
    }

    case "failure": {
      if (mode.format === "ndjson") {
        return [{ stream: "stdout", text: jsonLine({ event: "error", error: errorBody(outcome) }) }]
      }
      if (mode.format === "text") {
        const red = (text: string) => (mode.color ? `[31m${text}[0m` : text)
        const lines = [`${red("error:")} ${outcome.message}`]
        if (outcome.fix !== undefined) {
          lines.push(`fix: ${outcome.fix}`)
        }
        if (outcome.transient) {
          lines.push("note: this failure is transient — retrying may work")
        }
        return [{ stream: "stderr", text: `${lines.join("\n")}\n` }]
      }
      return [
        {
          stream: "stdout",
          text: jsonLine({
            schemaVersion: SCHEMA_VERSION,
            status: "error",
            error: errorBody(outcome),
            warnings: [],
          }),
        },
      ]
    }
  }
}
