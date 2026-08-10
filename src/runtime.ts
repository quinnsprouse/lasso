import { Cause, Exit, Schema } from "effect"
import type { RunFailure } from "./contract/adapter.ts"
import { classifyParserError, ExitSignal } from "./contract/adapter.ts"
import { AppError } from "./errors.ts"
import { ExitCode } from "./output/exit.ts"
import type { OutputMode } from "./output/format.ts"
import type { Outcome, Write } from "./output/outcome.ts"
import { renderOutcome } from "./output/outcome.ts"

/**
 * Pure settlement of a finished run: maps the Exit to the writes that still
 * need to happen and the process exit code. `bin.ts` feeds this to the real
 * process; the runtime tests feed it captured exits — same logic, one place.
 */
export interface Settled {
  readonly writes: ReadonlyArray<Write>
  readonly code: number
}

export const settleExit = (options: {
  readonly exit: Exit.Exit<void, unknown>
  readonly mode: OutputMode
  readonly binName: string
  /** Lazily built describe payload for machine-mode help answers. */
  readonly describeData: () => unknown
}): Settled => {
  const { exit, mode, binName } = options
  const render = (outcome: Outcome): ReadonlyArray<Write> => renderOutcome(mode, binName, outcome)

  if (Exit.isSuccess(exit)) {
    return { writes: [], code: ExitCode.success }
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { writes: [], code: ExitCode.interrupted }
  }

  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") {
    const error = failure.value
    if (Schema.is(ExitSignal)(error)) {
      return { writes: [], code: error.code }
    }
    if (Schema.is(AppError)(error)) {
      return {
        writes: render({
          kind: "failure",
          code: error.code,
          message: error.message,
          fix: error.fix,
          transient: error.transient,
          details: error.details,
        }),
        code: error.exit,
      }
    }
    const parserFailure: RunFailure = classifyParserError(error, binName)
    if (parserFailure !== null) {
      if (parserFailure.kind === "help") {
        if (parserFailure.parseErrors.length === 0) {
          // Explicit help that reached the runtime (text mode rendered it there).
          return {
            writes:
              mode.format === "text" ? [] : render({ kind: "ok", data: options.describeData() }),
            code: ExitCode.success,
          }
        }
        const first = parserFailure.parseErrors[0]!
        return {
          // Text mode already reported via the parser's formatter.
          writes:
            mode.format === "text"
              ? []
              : render({
                  kind: "failure",
                  code: "invalid_usage",
                  message: first.message,
                  fix: first.fix,
                  transient: false,
                }),
          code: ExitCode.usage,
        }
      }
      return {
        writes:
          mode.format === "text"
            ? []
            : render({
                kind: "failure",
                code: "invalid_usage",
                message: parserFailure.failure.message,
                fix: parserFailure.failure.fix,
                transient: false,
              }),
        code: ExitCode.usage,
      }
    }
  }

  const defect = Cause.squash(exit.cause)
  if (isEpipe(defect)) {
    return { writes: [], code: ExitCode.success }
  }
  return {
    writes: render({
      kind: "failure",
      code: "internal_error",
      message: defect instanceof Error ? defect.message : String(defect),
      transient: false,
    }),
    code: ExitCode.internalDefect,
  }
}

const isEpipe = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "EPIPE"
