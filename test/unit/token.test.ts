import { describe, expect, it } from "vitest"
import { assert as fcAssert, dictionary, jsonValue, property, string } from "fast-check"
import { canonicalJson, planToken } from "../../src/contract/token.ts"

describe("plan tokens", () => {
  it("is stable under key order", () => {
    expect(planToken({ a: 1, b: [{ x: 1, y: 2 }] })).toBe(planToken({ b: [{ y: 2, x: 1 }], a: 1 }))
  })

  it("changes when the plan changes", () => {
    expect(planToken({ a: 1 })).not.toBe(planToken({ a: 2 }))
  })

  it("canonical json rejects undefined members instead of silently dropping them", () => {
    // { a: 1 } and { a: 1, b: undefined } are different to apply; the token must not equate them.
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(/undefined/)
    expect(() => canonicalJson([undefined])).toThrow(/undefined/)
  })

  it("rejects functions, symbols, bigints, and class instances", () => {
    expect(() => planToken({ f: () => 1 })).toThrow(/function/)
    expect(() => planToken({ s: Symbol("x") })).toThrow(/symbol/)
    expect(() => planToken({ n: 1n })).toThrow(/bigint/)
    expect(() => planToken({ d: new Date(0) })).toThrow(/non-plain/)
    expect(() => planToken({ m: new Map() })).toThrow(/non-plain/)
    expect(planToken({ o: Object.create(null) })).toMatch(/^plan_/)
  })

  it("produces the plan_ prefix and a fixed length", () => {
    fcAssert(
      property(jsonValue(), (value) => {
        const token = planToken(value)
        expect(token).toMatch(/^plan_[0-9a-f]{16}$/)
      }),
    )
  })

  it("key order never changes the token (property)", () => {
    fcAssert(
      property(dictionary(string(), jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).toReversed())
        expect(planToken(reversed)).toBe(planToken(record))
      }),
    )
  })
})

describe("plan tokens reject values JSON cannot represent", () => {
  it("throws for NaN and infinities", () => {
    // JSON.stringify would map these to null, letting two different plans
    // share a token; the runtime fails loudly instead.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => planToken({ value })).toThrow(/non-JSON number/)
      expect(() => planToken({ nested: [{ value }] })).toThrow(/non-JSON number/)
    }
  })

  it("accepts every finite number; negative zero hashes as zero, as it serializes", () => {
    expect(planToken({ value: 0 })).toMatch(/^plan_/)
    expect(planToken({ value: -0 })).toBe(planToken({ value: 0 }))
    expect(planToken({ value: 1.5 })).toMatch(/^plan_/)
    expect(planToken({ value: Number.MAX_SAFE_INTEGER })).toMatch(/^plan_/)
  })
})
