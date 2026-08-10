import { Effect, Schema } from "effect"
import type { AnyContract, QueryContract } from "../contract/contract.ts"
import { defineQuery } from "../contract/contract.ts"
import { describeCli, schemaDocument } from "../contract/jsonschema.ts"
import { CLI_NAME, CLI_VERSION } from "../meta.ts"

/**
 * Runtime introspection: `describe` frees agents from parsing --help text,
 * `schema` publishes standalone JSON Schema for every command surface. Both
 * work with no auth, no network, no config, and no side effects.
 *
 * Built as a factory over the roster (late-bound, so the roster can include
 * these very commands without a circular value dependency).
 */
export const makeIntrospection = (
  roster: () => ReadonlyArray<AnyContract>,
): { describe: QueryContract; schema: QueryContract } => ({
  describe: defineQuery({
    name: "describe",
    summary: "Describe every command, capability, and protocol detail as JSON",
    stability: "stable",
    params: {},
    dataSchema: Schema.Unknown,
    domainErrorCodes: [],
    examples: [
      { command: "lasso describe --json", description: "Full machine-readable CLI inventory" },
    ],
    handler: () =>
      Effect.sync(() =>
        describeCli({ binName: CLI_NAME, version: CLI_VERSION, contracts: roster() }),
      ),
  }),
  schema: defineQuery({
    name: "schema",
    summary: "Emit JSON Schema (draft 2020-12) for command params, outputs, and plans",
    stability: "stable",
    params: {},
    dataSchema: Schema.Unknown,
    domainErrorCodes: [],
    examples: [
      { command: "lasso schema --json", description: "JSON Schema for every command surface" },
    ],
    handler: () =>
      Effect.sync(() =>
        schemaDocument({ binName: CLI_NAME, version: CLI_VERSION, contracts: roster() }),
      ),
  }),
})
