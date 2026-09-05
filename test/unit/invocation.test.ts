import { defineMutation, defineQuery } from "../../src/contract/contract.ts"
import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import { validateInvocation } from "../../src/contract/adapter.ts"
import { NodeServices } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { surfaceOf } from "../../src/contract/surface.ts"

/**
 * The invocation validator must agree with the real parser: every case here
 * was checked against `node src/bin.ts` with the same argv. A next action,
 * a guide snippet, or a skill row that passes here parses for real.
 */
const surfaces = contracts.map(surfaceOf)
const check = (...args: Array<string>) =>
  Effect.runPromise(validateInvocation(surfaces, args).pipe(Effect.provide(NodeServices.layer)))

describe("validateInvocation", () => {
  it("accepts what the parser accepts", async () => {
    await Promise.all(
      [
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
        ["task", "list", "--no-help"],
        ["task", "create", "--help"],
        ["task", "--help"],
      ].map(async (args) => {
        expect(await check(...args), args.join(" ")).toBeUndefined()
      }),
    )
  })

  it.each([
    ["nonsense"],
    ["task", "bogus"],
    ["task", "list", "--nope"],
    ["task", "list", "--status", "bogus"],
    ["task", "list", "--status"],
    ["task", "list", "--no-status", "all"],
    ["task", "list", "--status", "all", "--status", "open"],
    ["describe", "--command", "--json"],
    ["task", "list", "--log-level", "bogus"],
    ["--log-level", "bogus", "task", "list"],
    ["task", "list", "--format", "bogus"],
    ["task", "create"],
    ["guide", "get", "a", "b"],
    ["task", "create", "x", "--if-not-exists=maybe"],
    ["task", "create", "x", "--", "--json"],
    ["task", "create", "x", "--no-dry-run=true"],
    ["--json=true", "describe"],
    ["task", "--log-level", "debug", "bogus"],
    ["task", "--log-level", "bogus", "create", "x"],
    ["task", "--json=true", "create", "x"],
    ["task", "--bogus", "create", "x"],
    ["task", "list", "--json", "--format", "text"],
    ["task", "list", "--wizard"],
    ["task", "create", "x", "--dry-run", "--yes"],
    ["task", "create", "x", "--confirm", "token", "--yes"],
    ["task", "create", "--dry-run", "--no-if-not-exists", "true"],
    ["task", "list", "--help", "--bogus"],
  ])("rejects %j", async (...args) => {
    expect(await check(...args)).toBeTypeOf("string")
  })
})

it("validation never executes query, plan, or apply handlers", async () => {
  let calls = 0
  const touched = () =>
    Effect.sync(() => {
      calls += 1
      return "called"
    })
  const metadata = {
    summary: "Inert validation",
    stability: "experimental" as const,
    params: {},
    dataSchema: Schema.String,
    domainErrorCodes: [],
    examples: [],
  }
  const query = defineQuery({ ...metadata, name: "probe read", handler: touched })
  const mutation = defineMutation({
    ...metadata,
    name: "probe write",
    planSchema: Schema.String,
    idempotency: { kind: "none" },
    plan: touched,
    apply: touched,
  })
  const probe = [surfaceOf(query), surfaceOf(mutation)]
  await Promise.all(
    [
      ["probe", "read"],
      ["probe", "write", "--yes"],
      ["probe", "write", "--confirm", "token"],
      ["probe", "write", "--dry-run"],
      ["probe", "write", "--help"],
      ["--version"],
      ["--completions", "bash"],
    ].map(async (args) => {
      expect(
        await Effect.runPromise(
          validateInvocation(probe, args).pipe(Effect.provide(NodeServices.layer)),
        ),
      ).toBeUndefined()
    }),
  )
  expect(calls).toBe(0)
})
