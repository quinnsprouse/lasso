import { SchemaRepresentation } from "effect"
import type { SchemaAST } from "effect"
import type { AnyContract, ParamSpec } from "./contract.ts"
import { capabilitiesOf } from "./contract.ts"
import { kebabCase } from "./adapter.ts"
import { ExitCode } from "../output/exit.ts"
import { SCHEMA_VERSION } from "../output/envelope.ts"

/**
 * Serializes the registry into machine-readable surfaces:
 * `describe` (command inventory) and `schema` (JSON Schema Draft 2020-12
 * for each command's parameters, output, and plan).
 */

const paramJsonSchema = (spec: ParamSpec): Record<string, unknown> => {
  switch (spec.type) {
    case "boolean":
      return { type: "boolean" }
    case "integer":
      return { type: "integer" }
    case "choice":
      return { type: "string", enum: [...(spec.choices ?? [])] }
    case "path":
    case "string":
      return { type: "string" }
  }
}

export const describeCommand = (contract: AnyContract) => ({
  name: contract.name,
  summary: contract.summary,
  stability: contract.stability,
  capabilities: capabilitiesOf(contract),
  params: Object.fromEntries(
    Object.entries(contract.params as Record<string, ParamSpec>).map(([key, spec]) => [
      key,
      {
        kind: spec.kind,
        type: spec.type,
        description: spec.description,
        ...(spec.kind === "flag" ? { cliName: `--${kebabCase(key)}` } : {}),
        ...(spec.alias !== undefined ? { alias: spec.alias } : {}),
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        ...(spec.choices !== undefined ? { choices: [...spec.choices] } : {}),
        required: spec.kind === "argument",
      },
    ]),
  ),
  errorCodes: [...contract.errorCodes],
  examples: [...contract.examples],
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
    envelope: {
      ok: { schemaVersion: "string", status: "ok", data: "…", warnings: ["…"] },
      error: {
        schemaVersion: "string",
        status: "error",
        error: { code: "string", message: "string", fix: "string?", transient: "boolean" },
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
    exitCodes: ExitCode,
    globalFlags: ["--json", "--format <auto|json|text|ndjson>", "--no-input"],
  },
  commands: options.contracts.map(describeCommand),
})

const toJsonSchema = (schema: { readonly ast: SchemaAST.AST }): unknown =>
  SchemaRepresentation.toJsonSchemaDocument(SchemaRepresentation.toRepresentation(schema.ast))

export const commandSchemas = (contract: AnyContract) => ({
  name: contract.name,
  params: {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(contract.params as Record<string, ParamSpec>).map(([key, spec]) => [
        key,
        paramJsonSchema(spec),
      ]),
    ),
    required: Object.entries(contract.params as Record<string, ParamSpec>)
      .filter(([, spec]) => spec.kind === "argument")
      .map(([key]) => key),
  },
  output: toJsonSchema(contract.output),
  ...(contract.kind === "mutation" ? { plan: toJsonSchema(contract.planSchema) } : {}),
})

export const schemaDocument = (options: {
  readonly binName: string
  readonly version: string
  readonly contracts: ReadonlyArray<AnyContract>
}) => ({
  schemaVersion: SCHEMA_VERSION,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  cli: { name: options.binName, version: options.version },
  commands: options.contracts.map(commandSchemas),
})
