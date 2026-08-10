import type { AnyContract } from "../contract/contract.ts"
import { describe, schema } from "./introspection.ts"
import { taskCreate } from "./task-create.ts"
import { taskList } from "./task-list.ts"
// generator:imports — scripts/new-command.mjs inserts above this line

/**
 * The explicit command roster. Adding a command means: create the module,
 * export its contract, list it here (or run `node scripts/new-command.mjs`).
 * The contract-invariant tests run against this list, and Knip flags a
 * contract module that never lands here.
 */
export const contracts: ReadonlyArray<AnyContract> = [
  taskList,
  taskCreate,
  describe,
  schema,
  // generator:contracts — scripts/new-command.mjs inserts above this line
]
