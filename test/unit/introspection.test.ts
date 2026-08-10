import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"

/**
 * The introspection handlers over the real roster — the payloads agents
 * depend on for discovery, exercised as plain Effects.
 */

const find = (name: string) => contracts.find((contract) => contract.name === name)!

describe("describe command", () => {
  it("returns the full inventory with protocol details", async () => {
    const contract = find("describe")
    if (contract.kind !== "query") {
      throw new Error("describe must be a query")
    }
    const data = (await Effect.runPromise(
      contract.handler({}) as Effect.Effect<unknown>,
    )) as Record<string, any>
    expect(data["cli"].name).toBe("lasso")
    expect(data["commands"].length).toBe(contracts.length)
    expect(data["protocol"].exitCodes.confirmationRequired).toBe(4)
    const create = data["commands"].find((command: any) => command.name === "task create")
    expect(create.capabilities.idempotency).toEqual({
      kind: "conditional",
      parameter: "ifNotExists",
    })
    expect(create.params.map((param: any) => param.cliName)).toContain("--dry-run")
  })
})

describe("schema command", () => {
  it("returns standalone draft 2020-12 documents for every command", async () => {
    const contract = find("schema")
    if (contract.kind !== "query") {
      throw new Error("schema must be a query")
    }
    const data = (await Effect.runPromise(
      contract.handler({}) as Effect.Effect<unknown>,
    )) as Record<string, any>
    expect(data["dialect"]).toContain("2020-12")
    for (const command of data["commands"]) {
      expect(command.params.$schema).toContain("2020-12")
      expect(command.output.$schema).toContain("2020-12")
    }
    const create = data["commands"].find((command: any) => command.name === "task create")
    expect(create.plan.$schema).toContain("2020-12")
  })
})
