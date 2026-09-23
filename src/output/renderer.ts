import { Context, Effect, Layer, Predicate, Schema, Stdio, Stream } from "effect"
import { ProgressEvent } from "./envelope.ts"
import { ExitCode } from "./exit.ts"
import type { OutputMode } from "./format.ts"
import type { CommandOutcome, Write } from "./outcome.ts"
import { renderOutcome } from "./outcome.ts"

// Stdio keeps output capturable through test layers.

const decodeProgress = Schema.decodeUnknownEffect(ProgressEvent)
const encodeProgressLine = Schema.encodeEffect(Schema.fromJsonString(ProgressEvent))

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

/**
 * Adjacent writes to one stream, joined: an NDJSON collection becomes one
 * write instead of one per line, with the same bytes in the same order.
 */
const coalesce = (writes: ReadonlyArray<Write>): ReadonlyArray<Write> => {
  const joined: Array<Write> = []
  for (const write of writes) {
    const last = joined.at(-1)
    if (last?.stream === write.stream) {
      joined[joined.length - 1] = { stream: write.stream, text: last.text + write.text }
    } else {
      joined.push(write)
    }
  }
  return joined
}

/** Progress input; `completed` and `total` must appear together. */
export interface ProgressUpdate {
  readonly phase: string
  readonly message: string
  readonly completed?: number
  readonly total?: number
}

/**
 * The exit code of the terminal outcome the Renderer wrote, once it has. The
 * process boundary reads it: a written outcome is final, so settlement adds
 * nothing after it and exits with this code.
 */
export class TerminalLatch {
  code: ExitCode | undefined = undefined
}

/**
 * Neither method fails: a broken output stream cannot carry an error
 * envelope, so a write failure is a defect that settlement resolves.
 */
export interface RendererApi {
  readonly mode: OutputMode
  emit(outcome: CommandOutcome): Effect.Effect<void>
  /**
   * Nonterminal progress during a long command. NDJSON: a `progress` event
   * on stdout. JSON and text: a stderr line — stdout stays terminal-only.
   */
  progress(update: ProgressUpdate): Effect.Effect<void>
}

export class Renderer extends Context.Service<Renderer, RendererApi>()("lasso/output/Renderer") {
  static layer(
    mode: OutputMode,
    binName: string,
    terminal: TerminalLatch = new TerminalLatch(),
  ): Layer.Layer<Renderer, never, Stdio.Stdio> {
    return Layer.effect(
      Renderer,
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio

        const writeTo = (stream: "stdout" | "stderr", text: string) =>
          Stream.make(text).pipe(
            Stream.run(
              stream === "stdout"
                ? stdio.stdout({ endOnDone: false })
                : stdio.stderr({ endOnDone: false }),
            ),
            // A consumer that closed stdout (`| head`) is done reading, not failing.
            Effect.catchIf(isEpipe, () => Effect.void),
            Effect.orDie,
          )

        // Detached reporting fibers must not write after the terminal event; check
        // at execution time, even when a handler constructs a progress effect early.
        const progress = Effect.fn("Renderer.progress")(function* (update: ProgressUpdate) {
          if (terminal.code !== undefined) {
            return yield* Effect.die(new Error("progress after the terminal event"))
          }
          const event = yield* decodeProgress({
            event: "progress",
            phase: update.phase,
            message: update.message,
            ...(update.completed !== undefined ? { completed: update.completed } : {}),
            ...(update.total !== undefined ? { total: update.total } : {}),
          }).pipe(Effect.orDie)
          if (mode.format === "ndjson") {
            const line = yield* encodeProgressLine(event).pipe(Effect.orDie)
            return yield* writeTo("stdout", `${line}\n`)
          }
          const counter =
            event.completed !== undefined ? ` (${event.completed}/${event.total})` : ""
          return yield* writeTo("stderr", `progress[${event.phase}]: ${event.message}${counter}\n`)
        })

        return Renderer.of({
          mode,
          // Uninterruptible: once the terminal outcome starts, it is written whole.
          emit: (outcome) =>
            Effect.suspend(() => {
              if (terminal.code !== undefined) {
                return Effect.die(new Error("emit after the terminal event"))
              }
              terminal.code =
                outcome.kind === "confirmation" ? ExitCode.confirmationRequired : ExitCode.success
              return Effect.forEach(coalesce(renderOutcome(mode, binName, outcome)), (write) =>
                writeTo(write.stream, write.text),
              ).pipe(Effect.asVoid, Effect.uninterruptible)
            }),
          progress,
        })
      }),
    )
  }
}
