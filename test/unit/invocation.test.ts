import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import { validateInvocation } from "../../src/contract/invocation.ts"
import { surfaceOf } from "../../src/contract/surface.ts"

/**
 * The invocation validator must agree with the real parser: every case here
 * was checked against `node src/bin.ts` with the same argv. A next action,
 * a guide snippet, or a skill row that passes here parses for real.
 */
const surfaces = contracts.map(surfaceOf)
const check = (...args: Array<string>) => validateInvocation(surfaces, args)

describe("validateInvocation", () => {
  it("accepts what the parser accepts", () => {
    for (const args of [
      ["task", "list", "--status", "all", "--json"],
      ["task", "list", "--status=all"],
      ["task", "create", "x", "--if-not-exists", "--json"],
      ["task", "create", "x", "--if-not-exists=true"],
      ["task", "create", "x", "--no-if-not-exists"],
      ["task", "create", "x", "-y", "--json"],
      ["task", "create", "--", "--weird"],
      ["task", "create", "--json", "--", "--weird"],
      ["describe", "--command", "task create", "--json"],
      ["guide", "get", "task-ids", "--brief", "--format", "ndjson"],
      ["--log-level", "debug", "task", "list"],
      ["--version"],
      ["-h"],
      ["task", "--help"],
      ["task", "create", "-"],
      ["task", "create", "x", "--if-not-exists", "true"],
      ["task", "create", "x", "--if-not-exists=yes"],
      ["task", "create", "x", "--dry-run=true"],
      ["task", "--log-level", "debug", "create", "x", "--dry-run"],
      ["--completions=fish"],
      ["--completions", "sh"],
      ["--help=true"],
    ]) {
      expect(check(...args), args.join(" ")).toBeUndefined()
    }
  })

  it("rejects what the parser rejects, with the reason", () => {
    expect(check("nonsense")).toBe('"nonsense" is not a command')
    expect(check("task", "bogus")).toBe('"task bogus" is not a command')
    expect(check("task", "list", "--nope")).toBe('flag --nope is not declared for "task list"')
    expect(check("task", "list", "--status", "bogus")).toBe(
      '--status must be one of open | done | all, got "bogus"',
    )
    expect(check("task", "list", "--status")).toBe("--status needs a value")
    expect(check("task", "list", "--no-status", "all")).toBe(
      'flag --no-status is not declared for "task list"',
    )
    expect(check("task", "list", "--status", "all", "--status", "open")).toBe(
      "flag --status was given more than once",
    )
    expect(check("describe", "--command", "--json")).toBe("--command needs a value")
    expect(check("task", "list", "--log-level", "bogus")).toBe(
      'invalid value "bogus" for --log-level',
    )
    expect(check("--log-level", "bogus", "task", "list")).toBe(
      'invalid value "bogus" for --log-level',
    )
    expect(check("task", "list", "--format", "bogus")).toBe('invalid value "bogus" for --format')
    expect(check("task", "create")).toBe('"task create" needs 1 argument(s), got 0')
    expect(check("guide", "get", "a", "b")).toBe('"guide get" takes 1 argument(s), got 2')
    expect(check("task", "create", "x", "--if-not-exists=maybe")).toBe(
      'boolean flag --if-not-exists takes true|false, got "maybe"',
    )
    expect(check("task", "create", "x", "--", "--json")).toBe(
      '"task create" takes 1 argument(s), got 2',
    )
    expect(check()).toBe("no command named")
    expect(check("task", "create", "x", "--no-dry-run=true")).toBe(
      "negated flag --no-dry-run takes no value",
    )
    expect(check("--json=true", "describe")).toBe("--json takes no value")
    expect(check("task", "--log-level", "debug", "bogus")).toBe('"task bogus" is not a command')
    expect(check("task", "--log-level", "bogus", "create", "x")).toBe(
      'invalid value "bogus" for --log-level',
    )
    expect(check("task", "--json=true", "create", "x")).toBe("--json takes no value")
    expect(check("task", "--bogus", "create", "x")).toBe('unrecognized flag "--bogus"')
  })
})
