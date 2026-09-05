import { Cause, Clock, Effect, Layer, Schema } from "effect"
import { expect } from "vitest"
import type { InputOf, MutationContract, ParamSpec } from "../../src/contract/contract.ts"
import type { ErrorCode } from "../../src/errors.ts"
import { AppError } from "../../src/errors.ts"
import { canonicalJson } from "../../src/contract/token.ts"

const liveClock = Effect.runSync(Clock.clockWith(Effect.succeed))
const clockAt = (millis: number): Clock.Clock => ({
  monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: liveClock.monotonicTimeNanos,
  sleep: (duration) => liveClock.sleep(duration),
  currentTimeMillisUnsafe: () => millis,
  currentTimeMillis: Effect.succeed(millis),
  currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
})

type Expected = { readonly plan: unknown } | { readonly error: ErrorCode }

/** Each case supplies valid domain input, fresh read services, and an expected result. */
export const planFixture = <P extends Record<string, ParamSpec>, Plan, A, R, RApply>(
  contract: MutationContract<P, Plan, A, R, RApply>,
  options: {
    readonly name: string
    readonly input: InputOf<P>
    readonly layer: Layer.Layer<R>
    readonly expected: Expected
  },
) => ({
  contract,
  name: options.name,
  succeeds: "plan" in options.expected,
  async expectPlan() {
    const run = (at: number) =>
      Effect.runPromiseExit(
        contract
          .plan(options.input)
          .pipe(Effect.provide(options.layer), Effect.provideService(Clock.Clock, clockAt(at))),
      )
    const first = await run(1_700_000_000_000)
    const second = await run(1_731_536_000_000)
    if ("plan" in options.expected) {
      expect(first._tag).toBe("Success")
      expect(second._tag).toBe("Success")
      if (first._tag !== "Success" || second._tag !== "Success") return
      const encode = Schema.encodeUnknownSync(contract.planSchema)
      const encoded = encode(first.value)
      expect(encoded).toEqual(options.expected.plan)
      expect(canonicalJson(encoded)).toBe(canonicalJson(encode(second.value)))
      expect(
        encode(Schema.decodeUnknownSync(contract.planSchema)(JSON.parse(canonicalJson(encoded)))),
      ).toEqual(encoded)
    } else {
      expect(first._tag).toBe("Failure")
      expect(second._tag).toBe("Failure")
      if (first._tag !== "Failure" || second._tag !== "Failure") return
      const error = Cause.findErrorOption(first.cause)
      expect(error._tag).toBe("Some")
      if (error._tag !== "Some") return
      expect(Schema.is(AppError)(error.value)).toBe(true)
      expect(error.value.code).toBe(options.expected.error)
      expect(String(first)).toBe(String(second))
    }
  },
})
