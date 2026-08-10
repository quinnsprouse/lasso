import type { PlatformError } from "effect"
import { Context, Effect, Layer, Stdio, Stream } from "effect"
import type { OutputMode } from "./format.ts"
import type { Outcome } from "./outcome.ts"
import { renderOutcome } from "./outcome.ts"

/**
 * The Renderer owns stdout inside the Effect runtime. It is a thin adapter
 * over `renderOutcome` — the single definition of the wire format — writing
 * through the Stdio service so tests can capture output with a test layer.
 */
export interface RendererApi {
  readonly mode: OutputMode
  emit(outcome: Outcome): Effect.Effect<void, PlatformError.PlatformError>
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

        return Renderer.of({
          mode,
          emit: (outcome) =>
            Effect.forEach(renderOutcome(mode, binName, outcome), (write) =>
              writeTo(write.stream, write.text),
            ).pipe(Effect.asVoid),
          note: (message) => writeTo("stderr", `${message}\n`),
        })
      }),
    )
  }
}
