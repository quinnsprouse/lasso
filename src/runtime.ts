import { Cause, Effect, Exit } from "effect"
import type { ParserServices, RunFailure } from "./contract/adapter.ts"
import { classifyParserError, inspectInvocation, validateInvocation } from "./contract/adapter.ts"
import { finalizeGuidance, previewArgs, withReplacedToken } from "./contract/guidance.ts"
import type { CommandSurface } from "./contract/surface.ts"
import type { AppError, ErrorCode } from "./errors.ts"
import { ERROR_CATALOG, isAppError, isErrorCode, messageOf } from "./errors.ts"
import { ExitCode } from "./output/exit.ts"
import type { OutputMode } from "./output/format.ts"
import { DISCOVER, NEXT_LIMIT } from "./output/guidance.ts"
import type { Outcome, Write } from "./output/outcome.ts"
import { renderOutcome } from "./output/outcome.ts"

/**
 * Settlement of a finished run: maps the Exit to the writes that still
 * need to happen and the process exit code. `bin.ts` feeds this to the real
 * process; the runtime tests feed it captured exits — same logic, one place.
 */
export interface Settled {
  readonly writes: ReadonlyArray<Write>
  readonly code: number
}

interface SettleOptions {
  readonly exit: Exit.Exit<void, unknown>
  readonly mode: OutputMode
  readonly binName: string
  /** Lazily built describe payload for machine-mode help answers. */
  readonly describeData: () => unknown
  /** The command surfaces, so next actions on settled failures are validated like any other. */
  readonly surfaces: ReadonlyArray<CommandSurface>
  /** The exit code of the terminal outcome the Renderer already wrote (`TerminalLatch.code`). */
  readonly written: number | undefined
}

/** What a failed run settles to: the outcome still to write, if any, and the exit code. */
interface Failed {
  readonly code: number
  readonly outcome?: Outcome
}

export const settleExit = Effect.fn("settleExit")(function* (
  options: SettleOptions,
): Effect.fn.Return<Settled, never, ParserServices> {
  const { exit, written } = options
  if (written !== undefined) {
    return afterTerminal(exit, written)
  }
  if (Exit.isSuccess(exit)) {
    return { writes: [], code: ExitCode.success }
  }
  const { code, outcome } = yield* failed(exit.cause, options)
  if (outcome === undefined) {
    return { writes: [], code }
  }
  const guided = yield* finalizeGuidance(
    (args) => validateInvocation(options.surfaces, args),
    outcome,
  )
  return { writes: renderOutcome(options.mode, options.binName, guided), code }
})

/**
 * The run already wrote its one terminal outcome, so nothing more reaches
 * stdout: an interrupt that landed during or after that write, or a consumer
 * that closed stdout, keeps the outcome's exit code.
 */
const afterTerminal = (exit: Exit.Exit<void, unknown>, written: number): Settled =>
  Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
    ? { writes: [], code: written }
    : {
        writes: [
          {
            stream: "stderr",
            text: `internal error after the terminal outcome: ${messageOf(Cause.squash(exit.cause))}\n`,
          },
        ],
        code: ExitCode.internalDefect,
      }

/** A catalog failure: its exit and transience come from the catalog row. */
const failure = (
  code: ErrorCode,
  fields: Omit<Extract<Outcome, { kind: "failure" }>, "kind" | "code" | "transient">,
): Failed => ({
  code: ERROR_CATALOG[code].exit,
  outcome: { kind: "failure", code, transient: ERROR_CATALOG[code].transient, ...fields },
})

const DEFECT_FIX =
  "this is a bug in the CLI, not in the invocation; re-run with --log-level debug and report the output"

const failed = Effect.fn("settleExit.failed")(function* (
  cause: Cause.Cause<unknown>,
  options: SettleOptions,
): Effect.fn.Return<Failed, never, ParserServices> {
  const { mode, surfaces } = options
  if (Cause.hasInterruptsOnly(cause)) {
    // An interrupted run still ends its stream with a terminal event, so a
    // consumer that already saw progress never sees a stream without an end.
    const { command } = yield* inspectInvocation(surfaces, mode)
    return failure("interrupted", {
      message: "the command was interrupted before it finished",
      fix: "re-run the command without --yes or --confirm so a mutation is re-planned against the current state before it applies",
      next:
        command === undefined
          ? []
          : [
              {
                message: "re-run and re-plan against the current state",
                args: previewArgs(mode.argv, mode.format),
              },
            ],
      guides: command?.guides,
    })
  }
  const error = Cause.findErrorOption(cause)
  if (error._tag === "Some" && isAppError(error.value)) {
    return expected(error.value)
  }
  const parserFailure =
    error._tag === "Some" ? classifyParserError(error.value, options.binName) : null
  if (parserFailure?.kind === "help") {
    // Explicit help that reached the runtime (text mode rendered it there).
    return {
      code: ExitCode.success,
      ...(mode.format === "text" ? {} : { outcome: { kind: "ok", data: options.describeData() } }),
    }
  }
  if (parserFailure?.kind === "usage") {
    return yield* usage(parserFailure.failure, options)
  }
  return failure("internal_error", { message: messageOf(Cause.squash(cause)), fix: DEFECT_FIX })
})

/**
 * An expected failure. Exit and transience come from the catalog, never from
 * the error instance: an AppError built outside `Errors.*` cannot invent either.
 */
const expected = (error: AppError): Failed => {
  if (!isErrorCode(error.code)) {
    return failure("internal_error", {
      message: `error code "${error.code}" is not in the catalog: ${error.message}`,
      fix: "add the code to ERROR_CATALOG in src/errors.ts and build the error with Errors.*",
    })
  }
  const { message, fix, details, next, guides } = error
  return failure(error.code, { message, fix, details, next, guides })
}

/**
 * A usage error. The parser's closest spellings become next moves only when
 * the corrected invocation parses; a guess that does not is left out, not warned.
 */
const usage = Effect.fn("settleExit.usage")(function* (
  usageError: Extract<RunFailure, { kind: "usage" }>["failure"],
  { mode, surfaces }: SettleOptions,
): Effect.fn.Return<Failed, never, ParserServices> {
  const { correction } = usageError
  const corrected: Array<{ readonly candidate: string; readonly args: ReadonlyArray<string> }> = []
  if (correction !== undefined) {
    // Leave room for the discover move.
    for (const candidate of correction.candidates.slice(0, NEXT_LIMIT - 1)) {
      const replaced = withReplacedToken(mode.argv, correction.token, candidate)
      const args = replaced === undefined ? undefined : previewArgs(replaced, mode.format)
      if (args !== undefined && (yield* validateInvocation(surfaces, args)) === undefined) {
        corrected.push({ candidate, args })
      }
    }
  }
  const best = corrected[0]
  return failure("invalid_usage", {
    message: usageError.message,
    fix:
      best === undefined || correction === undefined
        ? usageError.fix
        : `use "${best.candidate}" instead of "${correction.token}"`,
    next: [
      ...corrected.map(({ candidate, args }) => ({
        message: `did you mean "${candidate}"?`,
        args,
      })),
      DISCOVER,
    ],
  })
})
