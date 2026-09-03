import type { PlatformError } from "effect"
import { Context, Effect, Layer, Schema, Stdio, Stream } from "effect"
import { ProgressEvent } from "./envelope.ts"
import type { OutputMode } from "./format.ts"
import type { Outcome } from "./outcome.ts"
import { renderOutcome } from "./outcome.ts"

/**
 * The Renderer owns stdout inside the Effect runtime. It is a thin adapter
 * over `renderOutcome` — the single definition of the wire format — writing
 * through the Stdio service so tests can capture output with a test layer.
 */

const decodeProgress = Schema.decodeUnknownSync(ProgressEvent)
const encodeProgressLine = Schema.encodeSync(Schema.fromJsonString(ProgressEvent))

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
}

export class Renderer extends Context.Service<Renderer, RendererApi>()("lasso/output/Renderer") {
  static layer(mode: OutputMode, binName: string): Layer.Layer<Renderer, never, Stdio.Stdio> {
    return Layer.effect(
      Renderer,
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio
        // The terminal latch: after an outcome is emitted, any further
        // output through this Renderer is a defect, so a detached reporting
        // fiber can never write past the terminal event.
        let terminated = false

        const writeTo = (stream: "stdout" | "stderr", text: string) =>
          Stream.make(text).pipe(
            Stream.run(
              stream === "stdout"
                ? stdio.stdout({ endOnDone: false })
                : stdio.stderr({ endOnDone: false }),
            ),
          )

        // Both latch checks run inside Effect.suspend, i.e. when the effect
        // EXECUTES, not when the handler builds it. A progress effect that a
        // handler constructed early and ran late still hits the latch.
        const progress = (update: ProgressUpdate) =>
          Effect.suspend(() => {
            if (terminated) {
              return Effect.die(new Error("progress after the terminal event"))
            }
            // One shared contract: the same schema that types the wire event
            // validates every report (kebab phase, counter pairing, bounds).
            let event: ProgressEvent
            try {
              event = decodeProgress({
                event: "progress",
                phase: update.phase,
                message: update.message,
                ...(update.completed !== undefined ? { completed: update.completed } : {}),
                ...(update.total !== undefined ? { total: update.total } : {}),
              })
            } catch (cause) {
              return Effect.die(cause)
            }
            if (mode.format === "ndjson") {
              return writeTo("stdout", `${encodeProgressLine(event)}\n`)
            }
            const counter =
              event.completed !== undefined ? ` (${event.completed}/${event.total})` : ""
            return writeTo("stderr", `progress[${event.phase}]: ${event.message}${counter}\n`)
          })

        return Renderer.of({
          mode,
          emit: (outcome) =>
            Effect.suspend(() => {
              if (terminated) {
                return Effect.die(new Error("emit after the terminal event"))
              }
              terminated = true
              return Effect.forEach(renderOutcome(mode, binName, outcome), (write) =>
                writeTo(write.stream, write.text),
              ).pipe(Effect.asVoid)
            }),
          progress,
        })
      }),
    )
  }
}
