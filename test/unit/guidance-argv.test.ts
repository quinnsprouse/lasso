import { describe, expect, it } from "vitest"
import { withMachineFormat, withoutFlag, withReplacedToken } from "../../src/contract/guidance.ts"

// The argv rewrites behind confirmArgs, re-plans, and corrected next moves.
// Everything after a `--` terminator is a positional value and never rewritten.

describe("withReplacedToken", () => {
  it("replaces the first matching token", () => {
    expect(withReplacedToken(["task", "lst", "lst"], "lst", "list")).toEqual([
      "task",
      "list",
      "lst",
    ])
  })

  it("keeps a flag's inline value", () => {
    expect(withReplacedToken(["task", "list", "--stauts=done"], "--stauts", "--status")).toEqual([
      "task",
      "list",
      "--status=done",
    ])
  })

  it("never rewrites a positional after --", () => {
    expect(withReplacedToken(["task", "create", "--", "lst"], "lst", "list")).toBeUndefined()
  })

  it("does not treat a value that merely starts like the token as a match", () => {
    expect(withReplacedToken(["task", "lst=x"], "lst", "list")).toBeUndefined()
  })
})

describe("withoutFlag", () => {
  it.each([
    [["x", "--yes"], "--yes", false, ["x"]],
    [["x", "--yes", "true"], "--yes", false, ["x"]],
    [["x", "--yes=true"], "--yes", false, ["x"]],
    [["x", "--no-yes"], "--yes", false, ["x"]],
    [["x", "--confirm", "plan_1"], "--confirm", true, ["x"]],
    [["x", "--confirm=plan_1"], "--confirm", true, ["x"]],
    [["x", "--", "--yes"], "--yes", false, ["x", "--", "--yes"]],
  ] as const)("%j without %s", (argv, flag, takesValue, expected) => {
    expect(withoutFlag(argv, flag, takesValue)).toEqual(expected)
  })
})

describe("withMachineFormat", () => {
  it("inserts the format before a -- terminator", () => {
    expect(withMachineFormat(["task", "create", "--", "-x"], ["--json"])).toEqual([
      "task",
      "create",
      "--json",
      "--",
      "-x",
    ])
  })
})
