import { Cause, Effect, Exit, Predicate, Schema } from "effect"
import type { ParserServices } from "./contract/adapter.ts"
import { classifyParserError, inspectInvocation, validateInvocation } from "./contract/adapter.ts"
import { ExitSignal } from "./contract/execute.ts"
import {
  finalizeGuidance,
  formatArgs,
  withMachineFormat,
  withoutFlag,
  withReplacedToken,
} from "./contract/guidance.ts"
import type { CommandSurface } from "./contract/surface.ts"
import { AppError, ERROR_CATALOG, isErrorCode } from "./errors.ts"
import { ExitCode } from "./output/exit.ts"
import type { OutputMode } from "./output/format.ts"
import type { NextAction } from "./output/guidance.ts"
import { DISCOVER } from "./output/guidance.ts"
import type { Outcome, Write } from "./output/outcome.ts"
import { renderOutcome } from "./output/outcome.ts"

const isExitSignal = Schema.is(ExitSignal)
const isAppError = Schema.is(AppError)

/**
 * Settlement of a finished run: maps the Exit to the writes that still
 * need to happen and the process exit code. `bin.ts` feeds this to the real
 * process; the runtime tests feed it captured exits — same logic, one place.
 */
export interface Settled {
  readonly writes: ReadonlyArray<Write>
  readonly code: number
}

export const settleExit = Effect.fn("settleExit")(function* (options: {
  readonly exit: Exit.Exit<void, unknown>
  readonly mode: OutputMode
  readonly binName: string
  /** Lazily built describe payload for machine-mode help answers. */
  readonly describeData: () => unknown
  /** The command surfaces, so next actions on settled failures are validated like any other. */
  readonly surfaces: ReadonlyArray<CommandSurface>
  /** The terminal outcome the Renderer already wrote, if any (`TerminalLatch.kind`). */
  readonly written: Outcome["kind"] | undefined
}): Effect.fn.Return<Settled, never, ParserServices> {
  const { exit, mode, binName, surfaces, written } = options
  if (Exit.isSuccess(exit)) {
    return { writes: [], code: ExitCode.success }
  }
  if (written !== undefined) {
    return afterTerminal(exit.cause, written)
  }
  const render = (outcome: Outcome): ReadonlyArray<Write> => renderOutcome(mode, binName, outcome)
  const guided = Effect.fn("settleExit.guided")(function* (
    outcome: Outcome,
    input: {
      readonly next?: ReadonlyArray<NextAction> | undefined
      readonly guides?: ReadonlyArray<string> | undefined
    },
  ) {
    const guidance = yield* finalizeGuidance((args) => validateInvocation(surfaces, args), input)
    return {
      ...outcome,
      next: guidance.next,
      guides: guidance.guides,
      warnings: [...(outcome.warnings ?? []), ...guidance.warnings],
    } satisfies Outcome
  })
  /** argv without any mutation control, in the negotiated machine format: it previews, never applies. */
  const previewing = (argv: ReadonlyArray<string>) =>
    withMachineFormat(
      withoutFlag(withoutFlag(withoutFlag(argv, "--confirm", true), "--yes"), "-y"),
      formatArgs(mode.format),
    )

  if (Cause.hasInterruptsOnly(exit.cause)) {
    const { command: invoked } = yield* inspectInvocation(surfaces, mode)
    // An interrupted run still ends its stream with a terminal event, so a
    // consumer that already saw progress never sees a stream without an end.
    return {
      writes: render(
        yield* guided(
          {
            kind: "failure",
            code: "interrupted",
            message: "the command was interrupted before it finished",
            fix: "re-run the command without --yes or --confirm so a mutation is re-planned against the current state before it applies",
            transient: true,
          },
          {
            next:
              invoked === undefined
                ? []
                : [
                    {
                      message: "re-run and re-plan against the current state",
                      args: previewing(mode.argv),
                    },
                  ],
            guides: invoked?.guides,
          },
        ),
      ),
      code: ExitCode.interrupted,
    }
  }

  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") {
    const error = failure.value
    if (isExitSignal(error)) {
      return { writes: [], code: error.code }
    }
    if (isAppError(error)) {
      // Exit and transience come from the catalog, never from the error
      // instance: an AppError built outside `Errors.*` cannot invent either.
      if (!isErrorCode(error.code)) {
        return {
          writes: render({
            kind: "failure",
            code: "internal_error",
            message: `error code "${error.code}" is not in the catalog: ${error.message}`,
            fix: "add the code to ERROR_CATALOG in src/errors.ts and build the error with Errors.*",
            transient: false,
          }),
          code: ExitCode.internalDefect,
        }
      }
      return {
        writes: render(
          yield* guided(
            {
              kind: "failure",
              code: error.code,
              message: error.message,
              fix: error.fix,
              transient: ERROR_CATALOG[error.code].transient,
              details: error.details,
            },
            { next: error.next, guides: error.guides },
          ),
        ),
        code: ERROR_CATALOG[error.code].exit,
      }
    }
    const parserFailure = classifyParserError(error, binName)
    if (parserFailure !== null) {
      if (parserFailure.kind === "help") {
        // Explicit help that reached the runtime (text mode rendered it there).
        return {
          writes:
            mode.format === "text" ? [] : render({ kind: "ok", data: options.describeData() }),
          code: ExitCode.success,
        }
      }
      // The parser's closest spellings become next moves only when the
      // corrected invocation parses; a guess that does not is left out, not warned.
      const { message, fix, correction } = parserFailure.failure
      const corrected: Array<{ readonly candidate: string; readonly args: ReadonlyArray<string> }> =
        []
      if (correction !== undefined) {
        for (const candidate of correction.candidates.slice(0, 2)) {
          const replaced = withReplacedToken(mode.argv, correction.token, candidate)
          const args = replaced === undefined ? undefined : previewing(replaced)
          if (args !== undefined && (yield* validateInvocation(surfaces, args)) === undefined) {
            corrected.push({ candidate, args })
          }
        }
      }
      return {
        writes: render(
          yield* guided(
            {
              kind: "failure",
              code: "invalid_usage",
              message,
              fix:
                corrected[0] === undefined || correction === undefined
                  ? fix
                  : `use "${corrected[0].candidate}" instead of "${correction.token}"`,
              transient: false,
            },
            {
              next: [
                ...corrected.map(({ candidate, args }) => ({
                  message: `did you mean "${candidate}"?`,
                  args,
                })),
                DISCOVER,
              ],
            },
          ),
        ),
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
      fix: "this is a bug in the CLI, not in the invocation; re-run with --log-level debug and report the output",
      transient: false,
    }),
    code: ExitCode.internalDefect,
  }
})

/**
 * The run already wrote its one terminal outcome, so nothing more reaches
 * stdout: an interrupt that landed during or after that write, or a consumer
 * that closed stdout, keeps the outcome's exit code.
 */
const afterTerminal = (cause: Cause.Cause<unknown>, written: Outcome["kind"]): Settled => {
  const failure = Cause.findErrorOption(cause)
  if (failure._tag === "Some" && isExitSignal(failure.value)) {
    return { writes: [], code: failure.value.code }
  }
  if (Cause.hasInterruptsOnly(cause) || isEpipe(Cause.squash(cause))) {
    return {
      writes: [],
      code:
        written === "confirmation"
          ? ExitCode.confirmationRequired
          : written === "ok"
            ? ExitCode.success
            : ExitCode.internalDefect,
    }
  }
  const defect = Cause.squash(cause)
  return {
    writes: [
      {
        stream: "stderr",
        text: `internal error after the terminal outcome: ${defect instanceof Error ? defect.message : String(defect)}\n`,
      },
    ],
    code: ExitCode.internalDefect,
  }
}

/**
 * A closed stdout arrives as a PlatformError from the Stdio service with the
 * native `EPIPE` error nested in `cause` (or `reason`), so the check walks
 * the chain instead of reading only the top-level `code`.
 */
const isEpipe = (error: unknown, depth = 0): boolean =>
  depth <= 8 &&
  Predicate.isObjectKeyword(error) &&
  ((Predicate.hasProperty(error, "code") && error.code === "EPIPE") ||
    (["cause", "reason", "error"] as const).some(
      (key) => Predicate.hasProperty(error, key) && isEpipe(error[key], depth + 1),
    ))
