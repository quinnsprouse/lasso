import { Effect, Schema } from "effect"
import type { AnyContract, QueryContract } from "../contract/contract.ts"
import { defineQuery } from "../contract/contract.ts"
import { describeCli, schemaDocument } from "../contract/jsonschema.ts"
import { Errors } from "../errors.ts"
import { CLI_NAME, CLI_VERSION } from "../meta.ts"

// Read the roster lazily so describe/schema can include their own definitions.
export const makeIntrospection = (
  roster: () => ReadonlyArray<AnyContract>,
): { describe: QueryContract<any, any>; schema: QueryContract<any, any> } => ({
  describe: defineQuery({
    name: "describe",
    summary: "Describe every command, capability, guide, and protocol detail as JSON",
    stability: "stable",
    params: {
      command: {
        kind: "flag",
        type: "string",
        description:
          'Describe one command only (its full name, e.g. "task create"), with just the guides it references',
      },
    },
    dataSchema: Schema.Unknown,
    domainErrorCodes: ["not_found"],
    examples: [
      { command: "lasso describe --json", description: "Full machine-readable CLI inventory" },
      {
        command: 'lasso describe --command "task create" --json',
        description: "One command's surface and guides, for a smaller context budget",
      },
    ],
    handler: Effect.fn("describe.handler")(function* (input) {
      const contracts = roster()
      if (input.command !== undefined && !contracts.some((c) => c.name === input.command)) {
        return yield* Errors.notFound({
          message: `no command named "${input.command}"`,
          fix: `run ${CLI_NAME} describe --json to list commands`,
          next: [{ message: "list every command", args: ["describe", "--json"] }],
        })
      }
      return describeCli({
        binName: CLI_NAME,
        version: CLI_VERSION,
        contracts,
        ...(input.command !== undefined ? { only: input.command } : {}),
      })
    }),
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
