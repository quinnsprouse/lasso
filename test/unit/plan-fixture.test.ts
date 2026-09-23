import { expect, it } from "@effect/vitest"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { defineMutation } from "../../src/contract/contract.ts"
import { planFixture } from "../contract/plan-fixture.ts"

class Records extends Context.Service<
  Records,
  { readonly lookup: (id: string) => Effect.Effect<number> }
>()("test/Records") {}

const lookup = defineMutation({
  name: "record update",
  summary: "Plan a record update",
  stability: "experimental",
  params: { id: { kind: "argument", type: "string", description: "Record id" } },
  planSchema: Schema.Int,
  dataSchema: Schema.Int,
  domainErrorCodes: [],
  examples: [],
  idempotency: { kind: "none" },
  plan: Effect.fn("lookup.plan")(function* (input) {
    const records = yield* Records
    return yield* records.lookup(input.id)
  }),
  apply: (value) => Effect.succeed(value),
})

it.effect("accepts explicit domain inputs and read services unrelated to the task demo", () => {
  const fixture = planFixture(lookup, {
    name: "a known record",
    input: { id: "record_17" },
    layer: Layer.succeed(Records, {
      lookup: (id) => (id === "record_17" ? Effect.succeed(17) : Effect.die("unknown record")),
    }),
    expected: { plan: 17 },
  })
  return fixture.expectPlan()
})

it.effect("rejects a plan that changes when the clock changes", () => {
  const timed = defineMutation({
    ...lookup,
    name: "record timed",
    plan: () => Clock.currentTimeMillis,
  })
  const fixture = planFixture(timed, {
    name: "clock leak",
    input: { id: "record_17" },
    layer: Layer.empty,
    expected: { plan: 1_700_000_000_000 },
  })
  return Effect.gen(function* () {
    const outcome = yield* Effect.exit(fixture.expectPlan())
    expect(outcome._tag).toBe("Failure")
    expect(String(outcome)).toMatch(/expected/)
  })
})
