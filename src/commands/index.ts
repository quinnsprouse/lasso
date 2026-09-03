import type { MutationContract, QueryContract } from "../contract/contract.ts"
import type { ApplyServices, PlanServices, QueryServices } from "../services/index.ts"
import { makeGuideCommands } from "./guide.ts"
import { makeIntrospection } from "./introspection.ts"
import { taskAudit } from "./task-audit.ts"
import { taskCreate } from "./task-create.ts"
import { taskList } from "./task-list.ts"
// generator:imports — scripts/new-command.mjs inserts above this line

/**
 * Contracts admitted to the roster are pinned to their capability sets:
 * queries and plans read, applies write. A handler that needs an unwired
 * service — or the wrong capability for its role — fails to typecheck on
 * this list, not at runtime. Add services in src/services/index.ts.
 */
export type RosterContract =
  | QueryContract<any, any, QueryServices>
  | MutationContract<any, any, any, PlanServices, ApplyServices>

const introspection = makeIntrospection(() => contracts)
const guide = makeGuideCommands(() => contracts)

/**
 * The explicit command roster — the single registry. Adding a command means:
 * create the module, export its contract, list it here (or run
 * `node scripts/new-command.mjs`). Knip flags a contract module that never
 * lands here; the contract-invariant tests validate everything on the list.
 */
export const contracts: ReadonlyArray<RosterContract> = [
  taskList,
  taskAudit,
  taskCreate,
  introspection.describe,
  introspection.schema,
  guide.list,
  guide.get,
  // generator:contracts — scripts/new-command.mjs inserts above this line
]
