import { SchemaRepresentation } from "effect"
import type { SchemaAST } from "effect"
import type { AnyContract } from "./contract.ts"
import type { CommandSurface, SurfaceParam } from "./surface.ts"
import { errorCatalogTable, surfaceOf } from "./surface.ts"
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
 * CommandSurface the parser is built from, so they cannot drift.
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
})

export const describeCli = (options: {
  readonly binName: string
  readonly version: string
  readonly contracts: ReadonlyArray<AnyContract>
}) => ({
  schemaVersion: SCHEMA_VERSION,
  cli: { name: options.binName, version: options.version },
  protocol: {
    formats: ["json", "text", "ndjson"],
    globalFlags: [
      { cliName: "--json", description: "Output a JSON envelope" },
      { cliName: "--format", description: "Output format: auto | json | text | ndjson" },
      {
        cliName: "--no-input",
        description: "Never wait for input (this CLI never prompts; accepted for compatibility)",
      },
      { cliName: "--help", description: "In machine formats, answers with this describe payload" },
      { cliName: "--version", description: "CLI version (envelope or summary event)" },
      { cliName: "--log-level", description: "Runtime log level (diagnostics go to stderr)" },
      { cliName: "--wizard", description: "Interactive wizard — text mode on a terminal only" },
      {
        cliName: "--completions",
        description: "Print a shell completion script — text mode only",
      },
    ],
    flagSpellings: "Boolean flags also accept a --no-<name> negated form.",
    envelope: {
      ok: { schemaVersion: "string", status: "ok", data: "…", warnings: ["…"] },
      error: {
        schemaVersion: "string",
        status: "error",
        error: {
          code: "string",
          message: "string",
          fix: "string?",
          transient: "boolean",
          details: "unknown?",
        },
        warnings: ["…"],
      },
      confirmationRequired: {
        schemaVersion: "string",
        status: "confirmation_required",
        plan: "…",
        confirmation: { token: "string", confirmArgs: ["…"], confirmCommand: "string" },
        warnings: ["…"],
      },
    },
    ndjsonEvents: ["item", "warning", "progress", "summary", "confirmation_required", "error"],
    exitCodes: ExitCode,
    errorCatalog: errorCatalogTable(),
  },
  commands: options.contracts.map((contract) => describeSurface(surfaceOf(contract))),
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
