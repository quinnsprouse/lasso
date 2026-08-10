import type { MutationContract, QueryContract } from "../contract/contract.ts"
import type { AppServices } from "../services/index.ts"
import { makeIntrospection } from "./introspection.ts"
import { taskCreate } from "./task-create.ts"
import { taskList } from "./task-list.ts"
// generator:imports — scripts/new-command.mjs inserts above this line

/**
 * Contracts admitted to the roster may require only AppServices — a handler
 * that needs an unwired service fails to typecheck on this list, not at
 * runtime. Add services in src/services/index.ts.
 */
export type RosterContract =
  | QueryContract<any, any, AppServices>
  | MutationContract<any, any, any, AppServices, AppServices>

const introspection = makeIntrospection(() => contracts)

/**
 * The explicit command roster — the single registry. Adding a command means:
 * create the module, export its contract, list it here (or run
 * `node scripts/new-command.mjs`). Knip flags a contract module that never
 * lands here; the contract-invariant tests validate everything on the list.
 */
export const contracts: ReadonlyArray<RosterContract> = [
  taskList,
  taskCreate,
  introspection.describe,
  introspection.schema,
  // generator:contracts — scripts/new-command.mjs inserts above this line
]
