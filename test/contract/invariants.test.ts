import { mutationFixtures } from "../fixtures/mutations.ts"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import type { ParamSpec } from "../../src/contract/contract.ts"
import { commandSchemas, describeCli, schemaDocument } from "../../src/contract/jsonschema.ts"
import { GLOBAL_FLAG_ALIASES, GLOBAL_FLAG_NAMES } from "../../src/contract/invocation.ts"
import {
  FRAMEWORK_ALIASES,
  FRAMEWORK_CLI_NAMES,
  kebabCase,
  surfaceOf,
} from "../../src/contract/surface.ts"
import { planToken } from "../../src/contract/token.ts"
import { AppError, ERROR_CATALOG, Errors, factoryName } from "../../src/errors.ts"
import { CLI_NAME, CLI_VERSION } from "../../src/meta.ts"
import { ExitCode } from "../../src/output/exit.ts"

/**
 * Contract invariants: the mechanical rejections. These run in the Fast
 * profile, so an agent that adds a command violating the protocol finds out
 * before the code ever runs.
 */

/** Kit-owned CLI surface that contracts must not redeclare: the global flags plus the framework params. */
const RESERVED_CLI_NAMES = new Set([...GLOBAL_FLAG_NAMES, ...FRAMEWORK_CLI_NAMES])
const RESERVED_ALIASES = new Set([...GLOBAL_FLAG_ALIASES, ...FRAMEWORK_ALIASES])

const surfaces = contracts.map(surfaceOf)

describe("roster", () => {
  it("has the introspection commands", () => {
    const names = contracts.map((contract) => contract.name)
    for (const expected of ["describe", "schema"]) {
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
        expect(example.command === CLI_NAME || example.command.startsWith(`${CLI_NAME} `)).toBe(
          true,
        )
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
        expect(key).toMatch(/^[a-z][a-zA-Z0-9]*$/)
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

describe("error catalog", () => {
  /**
   * The table in docs/agents/COMMANDS.md IS the fixture: each row is parsed
   * and checked against the constructors, so the doc cannot drift from the
   * code and a new constructor without a documented row fails here.
   */
  const COMMANDS_DOC = join(import.meta.dirname, "..", "..", "docs", "agents", "COMMANDS.md")
  const DOCUMENTED = [
    ...readFileSync(COMMANDS_DOC, "utf8").matchAll(
      /^\| `Errors\.(\w+)` \| (\w+) \| (\d+) \| (yes|no) \|$/gm,
    ),
  ].map(
    ([, ctor, code, exit, transient]) =>
      [ctor as keyof typeof Errors, code!, Number(exit), transient === "yes"] as const,
  )

  it("documents at least the ten core constructors", () => {
    expect(DOCUMENTED.length).toBeGreaterThanOrEqual(10)
  })

  it.each(DOCUMENTED)("Errors.%s → %s, exit %i, transient %s", (ctor, code, exit, transient) => {
    const error = Errors[ctor]({ message: "m", fix: "f" })
    expect(error).toBeInstanceOf(AppError)
    expect(error.code).toBe(code)
    expect(error.exit).toBe(exit)
    expect(error.transient).toBe(transient)
    expect(error.fix).toBe("f")
    expect(ERROR_CATALOG[error.code as keyof typeof ERROR_CATALOG]).toMatchObject({
      exit,
      transient,
    })
  })

  it("every command-raised code has a factory named after it, documented in the table", () => {
    const commandCodes = Object.entries(ERROR_CATALOG)
      .filter(([, meta]) => meta.raisedBy === "command")
      .map(([code]) => code)
    expect(Object.keys(Errors).toSorted()).toEqual(commandCodes.map(factoryName).toSorted())
    expect(DOCUMENTED.map(([, code]) => code).toSorted()).toEqual(commandCodes.toSorted())
    for (const [ctor, code] of DOCUMENTED) {
      expect(ctor, `the factory for ${code} is Errors.${factoryName(code)}`).toBe(factoryName(code))
    }
    for (const [ctor] of DOCUMENTED) {
      expect(typeof Errors[ctor], `documented constructor Errors.${ctor} does not exist`).toBe(
        "function",
      )
    }
    const exits = new Set<number>(Object.values(ExitCode))
    for (const [code, meta] of Object.entries(ERROR_CATALOG)) {
      expect(exits.has(meta.exit), `${code} maps to unregistered exit ${meta.exit}`).toBe(true)
    }
  })

  it("transient codes are exactly the ones an agent may retry", () => {
    const transient = Object.entries(ERROR_CATALOG)
      .filter(([, meta]) => meta.transient)
      .map(([code]) => code)
      .toSorted()
    expect(transient).toEqual(["interrupted", "service_unavailable", "transient_failure"])
  })
})

describe("exit registry", () => {
  it("is frozen: every value is exactly as published", () => {
    expect(ExitCode).toEqual({
      success: 0,
      confirmationRequired: 4,
      usage: 64,
      invalidData: 65,
      serviceUnavailable: 69,
      internalDefect: 70,
      cannotWrite: 73,
      transient: 75,
      auth: 77,
      config: 78,
      interrupted: 130,
    })
  })
})

describe("mutation plan fixtures", () => {
  it("covers every registered mutation with a successful case", () => {
    const mutations = contracts.filter((contract) => contract.kind === "mutation")
    expect(
      new Set(
        mutationFixtures.filter((fixture) => fixture.succeeds).map((fixture) => fixture.contract),
      ),
    ).toEqual(new Set(mutations))
    for (const fixture of mutationFixtures) expect(mutations).toContain(fixture.contract)
  })

  it.each(mutationFixtures)("$contract.name: $name", async (fixture) => {
    await fixture.expectPlan()
  })
})
