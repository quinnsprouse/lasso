import type { PlatformError } from "effect"
import { Context, Effect, Layer, Stdio, Stream } from "effect"
import type { ProgressEvent } from "./envelope.ts"
import type { OutputMode } from "./format.ts"
import type { Outcome } from "./outcome.ts"
import { renderOutcome } from "./outcome.ts"

/**
 * The Renderer owns stdout inside the Effect runtime. It is a thin adapter
 * over `renderOutcome` — the single definition of the wire format — writing
 * through the Stdio service so tests can capture output with a test layer.
 */

/** Progress input; `completed` and `total` must appear together. */
export interface ProgressUpdate {
  readonly phase: string
  readonly message: string
  readonly completed?: number
  readonly total?: number
}

export interface RendererApi {
  readonly mode: OutputMode
  emit(outcome: Outcome): Effect.Effect<void, PlatformError.PlatformError>
  /**
   * Nonterminal progress during a long command. NDJSON: a `progress` event
   * on stdout. JSON and text: a stderr line — stdout stays terminal-only.
   */
  progress(update: ProgressUpdate): Effect.Effect<void, PlatformError.PlatformError>
  /** Diagnostic line — always stderr, never stdout. */
  note(message: string): Effect.Effect<void, PlatformError.PlatformError>
}

export class Renderer extends Context.Service<Renderer, RendererApi>()("lasso/output/Renderer") {
  static layer(mode: OutputMode, binName: string): Layer.Layer<Renderer, never, Stdio.Stdio> {
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
          )

        const progress = (update: ProgressUpdate) => {
          const { completed, total } = update
          if ((completed === undefined) !== (total === undefined)) {
            return Effect.die(new Error("progress requires completed and total together"))
          }
          if (
            completed !== undefined &&
            total !== undefined &&
            (completed > total || completed < 0)
          ) {
            return Effect.die(new Error("progress requires 0 <= completed <= total"))
          }
          if (mode.format === "ndjson") {
            const event: ProgressEvent = {
              event: "progress",
              phase: update.phase,
              message: update.message,
              ...(completed !== undefined && total !== undefined ? { completed, total } : {}),
            }
            return writeTo("stdout", `${JSON.stringify(event)}\n`)
          }
          const counter = completed !== undefined ? ` (${completed}/${total})` : ""
          return writeTo("stderr", `progress[${update.phase}]: ${update.message}${counter}\n`)
        }

        return Renderer.of({
          mode,
          emit: (outcome) =>
            Effect.forEach(renderOutcome(mode, binName, outcome), (write) =>
              writeTo(write.stream, write.text),
            ).pipe(Effect.asVoid),
          progress,
          note: (message) => writeTo("stderr", `${message}\n`),
        })
      }),
    )
  }
}
