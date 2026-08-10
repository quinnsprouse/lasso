import { Context, Effect, Layer } from "effect"
import type { ProgressUpdate } from "./renderer.ts"
import { Renderer } from "./renderer.ts"

/**
 * The progress capability handlers get: report-only, so a handler can narrate
 * a long operation without gaining the Renderer's power to emit outcomes.
 * NDJSON shows progress events on stdout; JSON and text put lines on stderr.
 */
export interface ProgressApi {
  /** Never fails: a broken output stream is a defect, not a handler error. */
  readonly report: (update: ProgressUpdate) => Effect.Effect<void>
}

export class Progress extends Context.Service<Progress, ProgressApi>()("lasso/output/Progress") {
  static readonly layer: Layer.Layer<Progress, never, Renderer> = Layer.effect(
    Progress,
    Effect.gen(function* () {
      const renderer = yield* Renderer
      return Progress.of({ report: (update) => renderer.progress(update).pipe(Effect.orDie) })
    }),
  )
}
