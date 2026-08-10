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

  it("canonical json drops undefined members", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
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
