import { Context, Effect, Schema } from "effect"
import type { RosterContract } from "../../src/commands/index.ts"
import { defineMutation, defineQuery } from "../../src/contract/contract.ts"

/**
 * Compile-time fixtures: these assertions run under `tsc --noEmit` in the
 * Fast profile. Each @ts-expect-error line FAILS the build if the invalid
 * state it documents ever becomes representable.
 */

const Message = Schema.Struct({ message: Schema.String })

// A service that is deliberately NOT part of AppServices.
class Unwired extends Context.Service<Unwired, { readonly x: Effect.Effect<string> }>()(
  "test/Unwired",
) {}

// --- Params ---------------------------------------------------------------

defineQuery({
  name: "fixture ok",
  summary: "valid",
  stability: "experimental",
  params: {
    flag: { kind: "flag", type: "boolean", description: "ok" },
  },
  dataSchema: Message,
  domainErrorCodes: [],
  examples: [{ command: "lasso fixture ok", description: "ok" }],
  handler: () => Effect.succeed({ message: "ok" }),
})

defineQuery({
  name: "fixture bad-boolean-default",
  summary: "boolean flags are presence flags — no defaults",
  stability: "experimental",
  params: {
    // @ts-expect-error boolean flags cannot declare a default
    flag: { kind: "flag", type: "boolean", default: true, description: "bad" },
  },
  dataSchema: Message,
  domainErrorCodes: [],
  examples: [{ command: "lasso x", description: "x" }],
  handler: () => Effect.succeed({ message: "ok" }),
})

defineQuery({
  name: "fixture bad-argument-alias",
  summary: "arguments take no alias",
  stability: "experimental",
  params: {
    // @ts-expect-error arguments cannot declare an alias
    title: { kind: "argument", type: "string", alias: "t", description: "bad" },
  },
  dataSchema: Message,
  domainErrorCodes: [],
  examples: [{ command: "lasso x", description: "x" }],
  handler: () => Effect.succeed({ message: "ok" }),
})

defineQuery({
  name: "fixture bad-choice",
  summary: "choice params must declare choices",
  stability: "experimental",
  params: {
    // @ts-expect-error choice params require a non-empty choices array
    pick: { kind: "flag", type: "choice", description: "bad" },
  },
  dataSchema: Message,
  domainErrorCodes: [],
  examples: [{ command: "lasso x", description: "x" }],
  handler: () => Effect.succeed({ message: "ok" }),
})

defineQuery({
  name: "fixture bad-integer-default",
  summary: "defaults must match the param type",
  stability: "experimental",
  params: {
    // @ts-expect-error an integer flag cannot default to a string
    count: { kind: "flag", type: "integer", default: "three", description: "bad" },
  },
  dataSchema: Message,
  domainErrorCodes: [],
  examples: [{ command: "lasso x", description: "x" }],
  handler: () => Effect.succeed({ message: "ok" }),
})

// --- Service wiring -------------------------------------------------------

const needsUnwired = defineQuery({
  name: "fixture unwired",
  summary: "requires a service outside AppServices",
  stability: "experimental",
  params: {},
  dataSchema: Message,
  domainErrorCodes: [],
  examples: [{ command: "lasso x", description: "x" }],
  handler: () =>
    Effect.gen(function* () {
      const service = yield* Unwired
      return { message: yield* service.x }
    }),
})

// A contract requiring an unwired service can never join the roster: this
// conditional resolves to false, and the assignment fails the build if the
// roster type ever starts admitting it.
type UnwiredIsRejected = typeof needsUnwired extends RosterContract ? true : false
const rejected: UnwiredIsRejected = false

// --- Mutations ------------------------------------------------------------

defineMutation({
  name: "fixture bad-mutation",
  summary: "mutations cannot skip planning",
  stability: "experimental",
  params: {},
  dataSchema: Message,
  domainErrorCodes: [],
  examples: [{ command: "lasso x", description: "x" }],
  idempotency: { kind: "none" },
  // @ts-expect-error mutations declare plan/apply — there is no handler shortcut
  handler: () => Effect.succeed({ message: "ok" }),
})

export const fixtures = { rejected }
