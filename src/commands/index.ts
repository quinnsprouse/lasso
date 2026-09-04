import type { MutationContract, QueryContract } from "../contract/contract.ts"
import type { ApplyServices, PlanServices, QueryServices } from "../services/index.ts"
import { makeGuideCommands } from "./guide.ts"
import { makeIntrospection } from "./introspection.ts"
import { taskAudit } from "./task-audit.ts"
import { taskCreate } from "./task-create.ts"
import { taskList } from "./task-list.ts"
// generator:imports — scripts/new-command.mjs inserts above this line

// Enforce read/write capabilities at registration. Add services in src/services/index.ts.
export type RosterContract =
  | QueryContract<any, any, QueryServices>
  | MutationContract<any, any, any, PlanServices, ApplyServices>

const introspection = makeIntrospection(() => contracts)
const guide = makeGuideCommands(() => contracts)

// Register commands here, or use scripts/new-command.mjs.
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
