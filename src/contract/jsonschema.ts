import { SchemaRepresentation } from "effect"
import type { SchemaAST } from "effect"
import type { AnyContract } from "./contract.ts"
import type { CommandSurface, SurfaceParam } from "./surface.ts"
import { errorCatalogTable, surfaceOf } from "./surface.ts"
import { guideInventory } from "../guides/catalog.ts"
import type { GlobalFlag } from "./invocation.ts"
import { GLOBAL_FLAGS } from "./invocation.ts"
import { ExitCode } from "../output/exit.ts"
import {
  ConfirmationEnvelope,
  ErrorEnvelope,
  OkEnvelope,
  SCHEMA_VERSION,
  StreamEvent,
} from "../output/envelope.ts"

/**
 * Serializes the normalized command surfaces into the two introspection
 * documents: `describe` (inventory) and `schema` (standalone JSON Schema,
 * draft 2020-12, for params, outputs, and plans). Both derive from the same
 * CommandSurface used to build the parser. Contract tests check the generated documents.
 */

const DIALECT = "https://json-schema.org/draft/2020-12/schema"

const paramJsonSchema = (param: SurfaceParam): Record<string, unknown> => {
  const base = (() => {
    switch (param.type) {
      case "boolean":
        return { type: "boolean" }
      case "integer":
        return { type: "integer" }
      case "choice":
        return { type: "string", enum: [...(param.choices ?? [])] }
      default:
        return { type: "string" }
    }
  })()
  return {
    ...base,
    description: param.description,
    ...(param.default !== undefined ? { default: param.default } : {}),
  }
}

/** A standalone draft 2020-12 document an agent can hand to any validator. */
const standaloneSchema = (ast: SchemaAST.AST): Record<string, unknown> => {
  const document = SchemaRepresentation.toJsonSchemaDocument(
    SchemaRepresentation.toRepresentation(ast),
  )
  const defs = document.definitions as Record<string, unknown>
  return {
    $schema: DIALECT,
    ...(document.schema as Record<string, unknown>),
    ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
  }
}

const describeGlobalFlag = (flag: GlobalFlag) => ({
  cliName: flag.cliName,
  ...(flag.alias !== undefined ? { alias: flag.alias } : {}),
  description: flag.description,
  ...(flag.values !== undefined ? { values: [...flag.values] } : {}),
})

const describeParam = (param: SurfaceParam) => ({
  key: param.key,
  cliName: param.cliName,
  kind: param.kind,
  type: param.type,
  description: param.description,
  required: param.required,
  owner: param.owner,
  ...(param.alias !== undefined ? { alias: param.alias } : {}),
  ...(param.default !== undefined ? { default: param.default } : {}),
  ...(param.choices !== undefined ? { choices: [...param.choices] } : {}),
})

const describeSurface = (surface: CommandSurface) => ({
  name: surface.name,
  summary: surface.contract.summary,
  stability: surface.contract.stability,
  capabilities: surface.capabilities,
  params: surface.params.map(describeParam),
  resultVariants: surface.resultVariants,
  errorCodes: surface.errorCodes,
  examples: [...surface.contract.examples],
  guides: surface.guides,
})

export const describeCli = (options: {
  readonly binName: string
  readonly version: string
  readonly contracts: ReadonlyArray<AnyContract>
  /**
   * Restrict the inventory to one command (describe --command): only that
   * command and the guide topics it references, for agents budgeting context.
   */
  readonly only?: string
}) => ({
  schemaVersion: SCHEMA_VERSION,
  cli: { name: options.binName, version: options.version },
  protocol: {
    formats: ["json", "text", "ndjson"],
    globalFlags: GLOBAL_FLAGS.map(describeGlobalFlag),
    flagSpellings: "Boolean flags also accept a --no-<name> negated form and --<name>=true|false.",
    // Envelope and event shapes: see `schema --json` (protocol.envelopes, protocol.streamEvent).
    guidance: {
      next: "Executable next moves as argv for this binary (no bin name), importance-ordered, at most 3, on every terminal outcome.",
      guides:
        "Guide topic ids to read for the model this outcome assumes; fetch with: guide get <topic>",
    },
    ndjsonEvents: ["item", "warning", "progress", "summary", "confirmation_required", "error"],
    exitCodes: ExitCode,
    errorCatalog: errorCatalogTable(),
  },
  commands: options.contracts
    .filter((contract) => options.only === undefined || contract.name === options.only)
    .map((contract) => describeSurface(surfaceOf(contract))),
  guideTopics: guideInventory(options.contracts, options.only),
})

export const commandSchemas = (contract: AnyContract) => {
  const surface = surfaceOf(contract)
  return {
    name: surface.name,
    params: {
      $schema: DIALECT,
      type: "object",
      properties: Object.fromEntries(
        surface.params.map((param) => [param.key, paramJsonSchema(param)]),
      ),
      required: surface.params.filter((param) => param.required).map((param) => param.key),
      additionalProperties: false,
    },
    output: standaloneSchema(contract.dataSchema.ast),
    ...(contract.kind === "mutation" ? { plan: standaloneSchema(contract.planSchema.ast) } : {}),
    ...(contract.kind === "query" && contract.collection !== undefined
      ? {
          // The shape of --fields output: items constrained to the declared
          // inventory (any subset), plus the count.
          projected: {
            $schema: DIALECT,
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  propertyNames: { enum: [...contract.collection.fields] },
                },
              },
              count: { type: "integer" },
            },
            required: ["items", "count"],
            additionalProperties: false,
          },
        }
      : {}),
  }
}

export const schemaDocument = (options: {
  readonly binName: string
  readonly version: string
  readonly contracts: ReadonlyArray<AnyContract>
}) => ({
  schemaVersion: SCHEMA_VERSION,
  dialect: DIALECT,
  cli: { name: options.binName, version: options.version },
  protocol: {
    envelopes: {
      ok: standaloneSchema(OkEnvelope.ast),
      error: standaloneSchema(ErrorEnvelope.ast),
      confirmationRequired: standaloneSchema(ConfirmationEnvelope.ast),
    },
    streamEvent: standaloneSchema(StreamEvent.ast),
  },
  commands: options.contracts.map(commandSchemas),
})
