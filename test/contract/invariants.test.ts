import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import type { ParamSpec } from "../../src/contract/contract.ts"
import { commandSchemas, describeCli, schemaDocument } from "../../src/contract/jsonschema.ts"
import { kebabCase, surfaceOf } from "../../src/contract/surface.ts"
import { planToken } from "../../src/contract/token.ts"
import { ERROR_CATALOG } from "../../src/errors.ts"
import { CLI_NAME, CLI_VERSION } from "../../src/meta.ts"

/**
 * Contract invariants: the mechanical rejections. These run in the Fast
 * profile, so an agent that adds a command violating the protocol finds out
 * before the code ever runs.
 */

/** Kit-owned CLI surface that contracts must not redeclare. */
const RESERVED_CLI_NAMES = new Set([
  "--fields",
  "--dry-run",
  "--confirm",
  "--yes",
  "--json",
  "--format",
  "--no-input",
  "--help",
  "--version",
  "--wizard",
  "--completions",
  "--log-level",
])
const RESERVED_ALIASES = new Set(["h", "v", "y"])

const surfaces = contracts.map(surfaceOf)

describe("roster", () => {
  it("has the demo and introspection commands", () => {
    const names = contracts.map((contract) => contract.name)
    for (const expected of ["task list", "task create", "describe", "schema"]) {
      expect(names).toContain(expected)
    }
  })

  it("has unique command paths and no group/leaf collisions", () => {
    const names = contracts.map((contract) => contract.name)
    expect(new Set(names).size).toBe(names.length)
    const groups = new Set(surfaces.filter((s) => s.path.length === 2).map((s) => s.path[0]!))
    const topLevel = surfaces.filter((s) => s.path.length === 1).map((s) => s.name)
    for (const name of topLevel) {
      expect(groups.has(name)).toBe(false)
    }
  })
})

describe.each(surfaces.map((surface) => [surface.name, surface] as const))(
  "contract %s",
  (_name, surface) => {
    const contract = surface.contract
    const contractParams = Object.entries(contract.params as Record<string, ParamSpec>)

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

    it("declares only catalog error codes", () => {
      for (const code of contract.domainErrorCodes) {
        expect(ERROR_CATALOG).toHaveProperty(code)
      }
      expect(new Set(contract.domainErrorCodes).size).toBe(contract.domainErrorCodes.length)
    })

    it("does not collide with kit-owned CLI names or aliases", () => {
      for (const param of surface.params.filter((p) => p.owner === "contract")) {
        expect(RESERVED_CLI_NAMES.has(param.cliName)).toBe(false)
        if (param.alias !== undefined) {
          expect(param.alias.length).toBe(1)
          expect(RESERVED_ALIASES.has(param.alias)).toBe(false)
        }
      }
    })

    it("has coherent param specs with unique CLI spellings", () => {
      const cliNames = surface.params.map((param) => param.cliName)
      expect(new Set(cliNames).size).toBe(cliNames.length)
      const aliases = surface.params
        .map((param) => param.alias)
        .filter((alias): alias is string => alias !== undefined)
      expect(new Set(aliases).size).toBe(aliases.length)

      for (const [key, spec] of contractParams) {
        expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/)
        expect(spec.description.length).toBeGreaterThan(0)
        if (spec.type === "choice") {
          expect(spec.choices.length).toBeGreaterThan(0)
          expect(new Set(spec.choices).size).toBe(spec.choices.length)
          if ("default" in spec && spec.default !== undefined) {
            expect(spec.choices).toContain(spec.default)
          }
        }
      }
    })

    it("kebab conversion produces unique flag names", () => {
      const kebabs = contractParams.map(([key]) => kebabCase(key))
      expect(new Set(kebabs).size).toBe(kebabs.length)
    })

    it("mutations carry framework controls and the stale_confirmation code", () => {
      if (contract.kind === "mutation") {
        const frameworkNames = surface.params
          .filter((param) => param.owner === "framework")
          .map((param) => param.cliName)
        expect(frameworkNames).toEqual(["--dry-run", "--confirm", "--yes"])
        expect(surface.errorCodes).toContain("stale_confirmation")
        expect(surface.resultVariants).toEqual(["success", "dryRun", "confirmationRequired"])
      }
    })

    it("collections expose --fields and the projected variant", () => {
      if (contract.kind === "query" && contract.collection !== undefined) {
        expect(surface.params.some((param) => param.cliName === "--fields")).toBe(true)
        expect(surface.resultVariants).toContain("projected")
        expect(contract.collection.fields.length).toBeGreaterThan(0)
        expect(new Set(contract.collection.fields).size).toBe(contract.collection.fields.length)
      }
    })

    it("generates standalone JSON Schema for every surface", () => {
      const schemas = commandSchemas(contract)
      expect(schemas.params.$schema).toContain("2020-12")
      expect(schemas.params.additionalProperties).toBe(false)
      const output = schemas.output
      expect(output["$schema"]).toContain("2020-12")
      // Standalone: any local $refs must resolve inside the same document.
      const text = JSON.stringify(output)
      const refs = [...text.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)].map((m) => m[1]!)
      const defs = (output["$defs"] as Record<string, unknown> | undefined) ?? {}
      for (const ref of refs) {
        // $ref segments are JSON-Pointer-escaped: ~1 is "/", ~0 is "~".
        const key = ref.replaceAll("~1", "/").replaceAll("~0", "~")
        expect(Object.keys(defs)).toContain(key)
      }
      if (contract.kind === "mutation") {
        expect(schemas).toHaveProperty("plan")
      }
      if (contract.kind === "query" && contract.collection !== undefined) {
        const projected = (schemas as Record<string, any>)["projected"]
        expect(projected.$schema).toContain("2020-12")
        expect(projected.properties.items.items.propertyNames.enum).toEqual([
          ...contract.collection.fields,
        ])
      }
    })
  },
)

describe("confirmation tokens", () => {
  it("bind command identity and protocol version, not just the plan", () => {
    const plan = { action: "x" }
    const a = planToken({ command: "task create", schemaVersion: "1", plan })
    const b = planToken({ command: "task delete", schemaVersion: "1", plan })
    const c = planToken({ command: "task create", schemaVersion: "2", plan })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})

describe("describe document", () => {
  it("covers every contract, the exit registry, and the error catalog", () => {
    const document = describeCli({ binName: CLI_NAME, version: CLI_VERSION, contracts })
    expect(document.commands.length).toBe(contracts.length)
    expect(document.protocol.exitCodes.transient).toBe(75)
    expect(document.protocol.exitCodes.confirmationRequired).toBe(4)
    expect(document.protocol.errorCatalog.length).toBe(Object.keys(ERROR_CATALOG).length)
    expect(document.protocol.ndjsonEvents).toContain("confirmation_required")
    expect(document.protocol.ndjsonEvents).toContain("progress")
  })

  it("publishes standalone protocol schemas including the progress event", () => {
    const document = schemaDocument({ binName: CLI_NAME, version: CLI_VERSION, contracts })
    const stream = JSON.stringify(document.protocol.streamEvent)
    expect(stream).toContain('"progress"')
    expect(document.protocol.envelopes.ok).toHaveProperty("$schema")
  })

  it("describes the framework params for mutations and collections", () => {
    const document = describeCli({ binName: CLI_NAME, version: CLI_VERSION, contracts })
    const create = document.commands.find((command) => command.name === "task create")!
    const createFlags = create.params.map((param) => param.cliName)
    expect(createFlags).toContain("--dry-run")
    expect(createFlags).toContain("--confirm")
    expect(createFlags).toContain("--yes")
    const list = document.commands.find((command) => command.name === "task list")!
    expect(list.params.map((param) => param.cliName)).toContain("--fields")
  })
})
