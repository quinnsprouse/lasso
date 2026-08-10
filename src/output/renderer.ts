import type { PlatformError } from "effect"
import { Context, Effect, Layer, Stdio, Stream } from "effect"
import type { OutputMode } from "./format.ts"
import type { ConfirmationEnvelope, ErrorEnvelope, OkEnvelope, StreamEvent } from "./envelope.ts"
import { SCHEMA_VERSION } from "./envelope.ts"

/**
 * The Renderer owns stdout. Nothing else in the application may write to it —
 * enforced by lint (`no-console`) and the import-boundary check. Diagnostics
 * go to stderr; data goes to stdout; the two never mix.
 */
/** `confirmArgs` is the canonical form; the command string is display-only. */
const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

export interface RendererApi {
  readonly mode: OutputMode
  /** Emit a success envelope (JSON/NDJSON) or human text. */
  ok(options: {
    readonly data: unknown
    readonly text?: string
    readonly items?: ReadonlyArray<unknown>
    readonly warnings?: ReadonlyArray<string>
  }): Effect.Effect<void, PlatformError.PlatformError>
  /** Emit the exit-4 confirmation protocol envelope. */
  confirmation(options: {
    readonly plan: unknown
    readonly token: string
    readonly confirmArgs: ReadonlyArray<string>
    readonly text?: string
  }): Effect.Effect<void, PlatformError.PlatformError>
  /** Emit an error envelope (stdout in JSON mode, stderr in text mode). */
  fail(options: {
    readonly code: string
    readonly message: string
    readonly fix?: string
    readonly transient: boolean
    readonly details?: unknown
  }): Effect.Effect<void, PlatformError.PlatformError>
  /** Diagnostic line — always stderr, never stdout. */
  note(message: string): Effect.Effect<void, PlatformError.PlatformError>
}

export class Renderer extends Context.Service<Renderer, RendererApi>()("lasso/output/Renderer") {
  static layer(mode: OutputMode, binName: string): Layer.Layer<Renderer, never, Stdio.Stdio> {
    return Layer.effect(
      Renderer,
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio

        const writeOut = (text: string) =>
          Stream.make(text).pipe(Stream.run(stdio.stdout({ endOnDone: false })))
        const writeErr = (text: string) =>
          Stream.make(text).pipe(Stream.run(stdio.stderr({ endOnDone: false })))

        const emitJson = (value: unknown) => writeOut(`${JSON.stringify(value)}\n`)

        const ok: RendererApi["ok"] = (options) => {
          const warnings = options.warnings ?? []
          if (mode.format === "ndjson") {
            // Every NDJSON stream ends with a summary event, collection or not.
            const events: Array<StreamEvent> =
              options.items !== undefined
                ? [
                    ...warnings.map((message) => ({ event: "warning", message }) as const),
                    ...options.items.map((data) => ({ event: "item", data }) as const),
                    { event: "summary", data: { count: options.items.length } } as const,
                  ]
                : [
                    ...warnings.map((message) => ({ event: "warning", message }) as const),
                    { event: "summary", data: options.data } as const,
                  ]
            return Effect.forEach(events, emitJson, { discard: true })
          }
          if (mode.format === "text") {
            const body = options.text ?? JSON.stringify(options.data, null, 2)
            return Effect.gen(function* () {
              for (const warning of warnings) {
                yield* writeErr(`warning: ${warning}\n`)
              }
              yield* writeOut(`${body}\n`)
            })
          }
          const envelope: OkEnvelope = {
            schemaVersion: SCHEMA_VERSION,
            status: "ok",
            data: options.data,
            warnings,
          }
          return emitJson(envelope)
        }

        const confirmation: RendererApi["confirmation"] = (options) => {
          const confirmCommand = [binName, ...options.confirmArgs.map(shellQuote)].join(" ")
          if (mode.format === "text") {
            const body = options.text ?? JSON.stringify(options.plan, null, 2)
            return writeErr(
              `${body}\n\nThis change needs confirmation. Re-run with:\n  ${confirmCommand}\n`,
            )
          }
          const envelope: ConfirmationEnvelope = {
            schemaVersion: SCHEMA_VERSION,
            status: "confirmation_required",
            plan: options.plan,
            confirmation: {
              token: options.token,
              confirmArgs: options.confirmArgs,
              confirmCommand,
            },
            warnings: [],
          }
          return emitJson(envelope)
        }

        const fail: RendererApi["fail"] = (options) => {
          if (mode.format === "text") {
            const lines = [`error: ${options.message}`]
            if (options.fix !== undefined) {
              lines.push(`fix: ${options.fix}`)
            }
            if (options.transient) {
              lines.push("note: this failure is transient — retrying may work")
            }
            return writeErr(`${lines.join("\n")}\n`)
          }
          const envelope: ErrorEnvelope = {
            schemaVersion: SCHEMA_VERSION,
            status: "error",
            error: {
              code: options.code,
              message: options.message,
              ...(options.fix !== undefined ? { fix: options.fix } : {}),
              transient: options.transient,
              ...(options.details !== undefined ? { details: options.details } : {}),
            },
            warnings: [],
          }
          if (mode.format === "ndjson") {
            return emitJson({ event: "error", error: envelope.error })
          }
          return emitJson(envelope)
        }

        return Renderer.of({
          mode,
          ok,
          confirmation,
          fail,
          note: (message) => writeErr(`${message}\n`),
        })
      }),
    )
  }
}
