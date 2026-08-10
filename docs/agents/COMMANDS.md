# Adding commands

Start with the generator — it leaves the Fast profile green:

```bash
node scripts/new-command.mjs task ping     # creates src/commands/task-ping.ts, registers it
npm run check
```

Then shape the contract. Everything below is verified by the contract-invariant tests in `test/contract/invariants.test.ts`; violations fail `npm run check` with a specific assertion.

## Queries

```ts
export const taskList = register(
  defineQuery({
    name: "task list",              // "group leaf" or just "leaf"; two levels max
    summary: "List tasks",          // ≤88 chars, imperative
    stability: "stable",            // or "experimental"
    params: {
      status: {                     // key is camelCase → CLI flag is --status
        kind: "flag",               // or "argument" (positional, required)
        type: "choice",             // string | boolean | integer | choice | path
        choices: ["open", "done", "all"],
        default: "open",            // defaulted flags are always present in input
        description: "Filter tasks by status",
      },
    },
    output: TaskList,               // effect Schema; output is encoded through it
    errorCodes: ["invalid_config"], // codes this command can produce (see src/errors.ts)
    examples: [ /* at least one, starting with the bin name */ ],
    handler: (input) => Effect.gen(function* () { /* Effect<A, AppError, Services> */ }),
    render: (data) => "human text", // text mode; omit for pretty JSON
    items: (data) => data.items,    // collections only: enables NDJSON + --fields
  }),
)
```

## Mutations

Mutations are structurally `plan` + `apply`. The runtime owns `--dry-run`, `--confirm <token>`, and `--yes`; your contract never sees those flags.

```ts
defineMutation({
  // ...same base fields, plus:
  idempotent: true,                  // true only if replaying apply is safe
  planSchema: CreatePlan,            // the plan is encoded and hashed into the token
  plan: (input) => ...,              // validate, read state, produce a plan. NO side effects.
  apply: (plan, input) => ...,       // execute exactly that plan
  renderPlan: (plan) => "will ...",  // human preview
})
```

Rules the tests enforce:

- `errorCodes` must include `stale_confirmation` (the runtime can produce it for any mutation).
- Reserved params you may not declare: `fields`, `dryRun`, `confirm`, `yes`, `json`, `format`. Reserved aliases: `h`, `v`, `y`.
- Choice params declare `choices`; boolean flags never default to `true`; arguments take no alias/default.

## Errors

Handlers fail only with `AppError`, built from the `Errors.*` constructors in `src/errors.ts`. Pick the code by meaning, not convenience — agents branch on it:

| Constructor | code | exit | transient |
|---|---|---|---|
| `Errors.usage` | invalid_usage | 64 | no |
| `Errors.invalidData` | invalid_data | 65 | no |
| `Errors.notFound` | not_found | 65 | no |
| `Errors.conflict` | resource_conflict | 73 | no |
| `Errors.cannotWrite` | cannot_write | 73 | no |
| `Errors.serviceUnavailable` | service_unavailable | 69 | yes |
| `Errors.transient` | transient_failure | 75 | yes |
| `Errors.auth` | auth_failure | 77 | no |
| `Errors.config` | invalid_config | 78 | no |

Always set `fix` to an exact command or action, e.g. `` fix: `re-run with --if-not-exists` ``. Add a new code by extending `Errors` and `ErrorCode` in `src/errors.ts` — never inline an error shape.

## Services

Handlers reach the world through services (`src/services/`), never `node:fs` or `process` (lint blocks both). Define a service with `Context.Service`, give it a production `layer`, and provide it in `src/bin.ts`. Tests provide fake layers — see `test/unit/task-create.test.ts`.
