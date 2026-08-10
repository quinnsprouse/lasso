import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import { allContracts } from "../../src/contract/registry.ts"
import { capabilitiesOf, type ParamSpec } from "../../src/contract/contract.ts"
import { commandSchemas, describeCli, describeCommand } from "../../src/contract/jsonschema.ts"
import { CLI_NAME, CLI_VERSION } from "../../src/meta.ts"

/**
 * Contract invariants: the mechanical rejections. These run in the Fast
 * profile, so an agent that adds a command violating the protocol finds out
 * before the code ever runs.
 */

const KNOWN_ERROR_CODES = new Set([
  "invalid_usage",
  "invalid_data",
  "not_found",
  "resource_conflict",
  "cannot_write",
  "service_unavailable",
  "transient_failure",
  "auth_failure",
  "invalid_config",
  "stale_confirmation",
  "internal_error",
])

/** Kit-owned surface that contracts must not redeclare. */
const RESERVED_PARAM_NAMES = new Set(["fields", "dryRun", "confirm", "yes", "json", "format"])
const RESERVED_ALIASES = new Set(["h", "v", "y"])

describe("command registry", () => {
  it("has the demo and introspection commands registered", () => {
    const names = contracts.map((contract) => contract.name)
    expect(names).toContain("task list")
    expect(names).toContain("task create")
    expect(names).toContain("describe")
    expect(names).toContain("schema")
  })

  it("keeps the explicit roster and the registry in sync", () => {
    const roster = contracts.map((contract) => contract.name).toSorted()
    const registered = allContracts().map((contract) => contract.name)
    expect(roster).toEqual(registered)
  })
})

describe.each(contracts.map((contract) => [contract.name, contract] as const))(
  "contract %s",
  (_name, contract) => {
    const params = Object.entries(contract.params as Record<string, ParamSpec>)

    it("has a well-formed name and summary", () => {
      expect(contract.name).toMatch(/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/)
      expect(contract.summary.length).toBeGreaterThan(0)
      expect(contract.summary.length).toBeLessThanOrEqual(88)
    })

    it("ships at least one example that invokes this CLI", () => {
      expect(contract.examples.length).toBeGreaterThan(0)
      for (const example of contract.examples) {
        expect(example.command.startsWith(CLI_NAME)).toBe(true)
        expect(example.description.length).toBeGreaterThan(0)
      }
    })

    it("declares only known error codes", () => {
      for (const code of contract.errorCodes) {
        expect(KNOWN_ERROR_CODES.has(code)).toBe(true)
      }
    })

    it("does not redeclare kit-owned params or reserved aliases", () => {
      for (const [key, spec] of params) {
        expect(RESERVED_PARAM_NAMES.has(key)).toBe(false)
        if (spec.alias !== undefined) {
          expect(spec.alias.length).toBe(1)
          expect(RESERVED_ALIASES.has(spec.alias)).toBe(false)
        }
      }
    })

    it("has coherent param specs", () => {
      for (const [key, spec] of params) {
        expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/)
        expect(spec.description.length).toBeGreaterThan(0)
        if (spec.type === "choice") {
          expect(spec.choices !== undefined && spec.choices.length > 0).toBe(true)
          if (spec.default !== undefined) {
            expect(spec.choices).toContain(spec.default)
          }
        } else {
          expect(spec.choices).toBeUndefined()
        }
        if (spec.type === "boolean") {
          // Booleans are presence flags; a true default would be unsettable.
          expect(spec.default === undefined || spec.default === false).toBe(true)
        }
        if (spec.kind === "argument") {
          expect(spec.alias).toBeUndefined()
          expect(spec.default).toBeUndefined()
        }
      }
    })

    it("keeps alias assignments collision-free", () => {
      const aliases = params
        .map(([, spec]) => spec.alias)
        .filter((alias): alias is string => alias !== undefined)
      expect(new Set(aliases).size).toBe(aliases.length)
    })

    it("mutations declare failure modes", () => {
      if (contract.kind === "mutation") {
        expect(contract.errorCodes.length).toBeGreaterThan(0)
        expect(contract.errorCodes).toContain("stale_confirmation")
      }
    })

    it("derives capabilities without contradiction", () => {
      const capabilities = capabilitiesOf(contract)
      expect(capabilities.mutates).toBe(contract.kind === "mutation")
      expect(capabilities.supportsDryRun).toBe(contract.kind === "mutation")
      expect(capabilities.interactive).toBe(false)
    })

    it("serializes to describe output", () => {
      const described = describeCommand(contract)
      expect(described.name).toBe(contract.name)
      expect(described.capabilities).toBeDefined()
    })

    it("generates JSON Schema for every surface", () => {
      const schemas = commandSchemas(contract)
      expect(schemas.params).toHaveProperty("properties")
      expect(schemas.output).toBeDefined()
      if (contract.kind === "mutation") {
        expect(schemas).toHaveProperty("plan")
      }
    })
  },
)

describe("describe document", () => {
  it("covers every registered contract and the full protocol", () => {
    const document = describeCli({ binName: CLI_NAME, version: CLI_VERSION, contracts })
    expect(document.commands.length).toBe(contracts.length)
    expect(document.protocol.exitCodes.transient).toBe(75)
    expect(document.protocol.exitCodes.confirmationRequired).toBe(4)
    expect(document.protocol.formats).toEqual(["json", "text", "ndjson"])
  })
})
