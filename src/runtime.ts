import { Cause, Effect, Exit, Schema } from "effect"
import type { ParserServices, RunFailure } from "./contract/adapter.ts"
import {
  classifyParserError,
  ExitSignal,
  inspectInvocation,
  validateInvocation,
} from "./contract/adapter.ts"
import { AppError, ERROR_CATALOG } from "./errors.ts"
import {
  finalizeGuidance,
  formatArgs,
  withMachineFormat,
  withoutFlag,
} from "./contract/guidance.ts"
import type { CommandSurface } from "./contract/surface.ts"
import { ExitCode } from "./output/exit.ts"
import type { OutputMode } from "./output/format.ts"
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

export const settleExit = Effect.fn("settleExit")(function* (options: {
  readonly exit: Exit.Exit<void, unknown>
  readonly mode: OutputMode
  readonly binName: string
  /** Lazily built describe payload for machine-mode help answers. */
  readonly describeData: () => unknown
  /** The command surfaces, so next actions on settled failures are validated like any other. */
  readonly surfaces: ReadonlyArray<CommandSurface>
}): Effect.fn.Return<Settled, never, ParserServices> {
  const { exit, mode, binName, surfaces } = options
  const render = (outcome: Outcome): ReadonlyArray<Write> => renderOutcome(mode, binName, outcome)
  const guided = Effect.fn("settleExit.guided")(function* (
    outcome: Outcome,
    input: {
      readonly next?:
        | ReadonlyArray<{ readonly message: string; readonly args: ReadonlyArray<string> }>
        | undefined
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
  /** The invocation without any mutation control, in the negotiated machine format. */
  const replan = withMachineFormat(
    withoutFlag(withoutFlag(withoutFlag(mode.argv, "--confirm", true), "--yes"), "-y"),
    formatArgs(mode.format),
  )
  const discover = [{ message: "list every command and flag", args: ["describe", "--json"] }]
  if (Exit.isSuccess(exit)) {
    return { writes: [], code: ExitCode.success }
  }
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
                : [{ message: "re-run and re-plan against the current state", args: replan }],
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
    if (Schema.is(ExitSignal)(error)) {
      return { writes: [], code: error.code }
    }
    if (Schema.is(AppError)(error)) {
      // Exit and transience come from the catalog, never from the error
      // instance: an AppError built outside `Errors.*` cannot invent either.
      const entry = Object.hasOwn(ERROR_CATALOG, error.code)
        ? (ERROR_CATALOG as Record<string, { exit: number; transient: boolean }>)[error.code]
        : undefined
      if (entry === undefined) {
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
              transient: entry.transient,
              details: error.details,
            },
            { next: error.next, guides: error.guides },
          ),
        ),
        code: entry.exit,
      }
    }
    const parserFailure: RunFailure = classifyParserError(error, binName)
    if (parserFailure !== null) {
      if (parserFailure.kind === "help") {
        // Explicit help that reached the runtime (text mode rendered it there).
        return {
          writes:
            mode.format === "text" ? [] : render({ kind: "ok", data: options.describeData() }),
          code: ExitCode.success,
        }
      }
      return {
        writes: render(
          yield* guided(
            {
              kind: "failure",
              code: "invalid_usage",
              message: parserFailure.failure.message,
              fix: parserFailure.failure.fix,
              transient: false,
            },
            { next: discover },
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
 * A closed stdout arrives as a PlatformError from the Stdio service with the
 * native `EPIPE` error nested in `cause` (or `reason`), so the check walks
 * the chain instead of reading only the top-level `code`.
 */
const isEpipe = (error: unknown, depth = 0): boolean => {
  if (typeof error !== "object" || error === null || depth > 8) {
    return false
  }
  if ("code" in error && (error as { code?: unknown }).code === "EPIPE") {
    return true
  }
  const nested = error as { cause?: unknown; reason?: unknown; error?: unknown }
  return (
    isEpipe(nested.cause, depth + 1) ||
    isEpipe(nested.reason, depth + 1) ||
    isEpipe(nested.error, depth + 1)
  )
}
