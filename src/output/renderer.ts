import { Context, Effect, Layer, Schema, Stdio, Stream } from "effect"
import { ProgressEvent } from "./envelope.ts"
import type { OutputMode } from "./format.ts"
import type { Outcome } from "./outcome.ts"
import { renderOutcome } from "./outcome.ts"

// Stdio keeps output capturable through test layers.

const decodeProgress = Schema.decodeUnknownEffect(ProgressEvent)
const encodeProgressLine = Schema.encodeEffect(Schema.fromJsonString(ProgressEvent))

/** Progress input; `completed` and `total` must appear together. */
export interface ProgressUpdate {
  readonly phase: string
  readonly message: string
  readonly completed?: number
  readonly total?: number
}

/**
 * Records the terminal outcome the Renderer wrote, so settlement never adds a
 * second one: an interrupt or a closed stdout after it keeps that outcome.
 */
export class TerminalLatch {
  kind: Outcome["kind"] | undefined = undefined
}

/**
 * Neither method fails: a broken output stream cannot carry an error
 * envelope, so a write failure is a defect that settlement resolves.
 */
export interface RendererApi {
  readonly mode: OutputMode
  emit(outcome: Outcome): Effect.Effect<void>
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
            Effect.orDie,
          )

        // Detached reporting fibers must not write after the terminal event; check
        // at execution time, even when a handler constructs a progress effect early.
        const progress = Effect.fn("Renderer.progress")(function* (update: ProgressUpdate) {
          if (terminal.kind !== undefined) {
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
              if (terminal.kind !== undefined) {
                return Effect.die(new Error("emit after the terminal event"))
              }
              terminal.kind = outcome.kind
              return Effect.forEach(renderOutcome(mode, binName, outcome), (write) =>
                writeTo(write.stream, write.text),
              ).pipe(Effect.asVoid, Effect.uninterruptible)
            }),
          progress,
        })
      }),
    )
  }
}
