import { expect } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { InputOf, MutationContract, ParamSpec } from "../../src/contract/contract.ts"
import type { ErrorCode } from "../../src/errors.ts"
import { AppError } from "../../src/errors.ts"
import { canonicalJson } from "../../src/contract/token.ts"

type Expected = { readonly plan: unknown } | { readonly error: ErrorCode }

/**
 * Each case supplies valid domain input, fresh read services, and an expected
 * result. `layer` is required exactly when the plan reads services.
 */
export const planFixture = <P extends Record<string, ParamSpec>, Plan, A, R, RApply>(
  contract: MutationContract<P, Plan, A, R, RApply>,
  options: {
    readonly name: string
    readonly input: InputOf<P>
    readonly expected: Expected
  } & ([R] extends [never]
    ? { readonly layer?: Layer.Layer<never> }
    : { readonly layer: Layer.Layer<R> }),
) => ({
  contract,
  name: options.name,
  succeeds: "plan" in options.expected,
  /** Plans twice at different TestClock times; run it with `it.effect`. */
  expectPlan: Effect.fn("expectPlan")(function* () {
    const plan = contract
      .plan(options.input)
      .pipe(Effect.provide((options.layer ?? Layer.empty) as Layer.Layer<R>), Effect.exit)
    yield* TestClock.setTime(1_700_000_000_000)
    const first = yield* plan
    yield* TestClock.setTime(1_731_536_000_000)
    const second = yield* plan
    if ("plan" in options.expected) {
      if (!Exit.isSuccess(first) || !Exit.isSuccess(second)) {
        return expect.fail(`expected a plan, got ${String(Exit.isFailure(first) ? first : second)}`)
      }
      const encode = Schema.encodeUnknownEffect(contract.planSchema)
      const encoded = yield* encode(first.value)
      expect(encoded).toEqual(options.expected.plan)
      expect(canonicalJson(encoded)).toBe(canonicalJson(yield* encode(second.value)))
      // The plan survives the wire: canonical JSON back through the schema is lossless.
      const replayed = yield* Schema.decodeEffect(Schema.fromJsonString(contract.planSchema))(
        canonicalJson(encoded),
      ).pipe(Effect.flatMap(encode))
      expect(replayed).toEqual(encoded)
      return
    }
    if (!Exit.isFailure(first) || !Exit.isFailure(second)) {
      return expect.fail(`expected error "${options.expected.error}", got a plan`)
    }
    const error = Cause.findErrorOption(first.cause)
    if (error._tag !== "Some" || !Schema.is(AppError)(error.value)) {
      return expect.fail(`expected an AppError, got ${String(first)}`)
    }
    expect(error.value.code).toBe(options.expected.error)
    expect(String(first)).toBe(String(second))
  }),
})
