import { Effect, Schema } from "effect"
import { defineQuery } from "../contract/contract.ts"
import { allContracts, register } from "../contract/registry.ts"
import { describeCli, schemaDocument } from "../contract/jsonschema.ts"
import { CLI_NAME, CLI_VERSION } from "../meta.ts"

/**
 * Runtime introspection: `describe` frees agents from parsing --help text,
 * `schema` publishes JSON Schema for every command surface. Both work with
 * no auth, no network, no config, and no side effects.
 */

export const describe = register(
  defineQuery({
    name: "describe",
    summary: "Describe every command, capability, and protocol detail as JSON",
    stability: "stable",
    params: {},
    output: Schema.Unknown,
    errorCodes: [],
    examples: [
      { command: "lasso describe --json", description: "Full machine-readable CLI inventory" },
    ],
    handler: () =>
      Effect.sync(() =>
        describeCli({ binName: CLI_NAME, version: CLI_VERSION, contracts: allContracts() }),
      ),
  }),
)

export const schema = register(
  defineQuery({
    name: "schema",
    summary: "Emit JSON Schema (draft 2020-12) for command params, outputs, and plans",
    stability: "stable",
    params: {},
    output: Schema.Unknown,
    errorCodes: [],
    examples: [
      { command: "lasso schema --json", description: "JSON Schema for every command surface" },
    ],
    handler: () =>
      Effect.sync(() =>
        schemaDocument({ binName: CLI_NAME, version: CLI_VERSION, contracts: allContracts() }),
      ),
  }),
)
