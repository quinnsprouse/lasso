# Adding commands

Start with the generator — it leaves the Fast profile green:

```bash
node scripts/new-command.mjs task ping     # creates src/commands/task-ping.ts, registers it
npm run check
```

Then shape the contract. Everything below is verified by the contract-invariant tests in `test/contract/invariants.test.ts`; violations fail `npm run check` with a specific assertion.

## Queries

```ts
export const taskList = defineQuery({
  name: "task list",                   // "group leaf" or just "leaf"; two levels max
  summary: "List tasks",               // ≤88 chars, imperative
  stability: "stable",                 // or "experimental"
  params: {
    status: {                          // key is camelCase → CLI flag is --status
      kind: "flag",                    // or "argument" (positional, required)
      type: "choice",                  // string | boolean | integer | choice | path
      choices: ["open", "done", "all"],
      default: "open",                 // defaulted flags are always present in input
      description: "Filter tasks by status",
    },
  },
  dataSchema: TaskList,                // effect Schema; output is encoded through it
  domainErrorCodes: ["invalid_config"], // codes this command produces (src/errors.ts catalog)
  examples: [ /* at least one, starting with the bin name */ ],
  handler: (input) => Effect.gen(function* () { /* Effect<A, AppError, AppServices> */ }),
  renderText: (data) => "human text",  // text mode; omit for pretty JSON
  collection: {                        // collections only: enables NDJSON + --fields
    fields: ["id", "title", "status", "createdAt"],  // static projectable inventory
    items: (encoded) => /* rows from the ENCODED output */,
  },
})
```

Then register it in the roster in `src/commands/index.ts` — the single registry. The roster type constrains handler requirements to `AppServices`: a handler needing an unwired service fails `tsc`.

## Mutations

Mutations are structurally `plan` + `apply`. The runtime owns `--dry-run`, `--confirm <token>`, and `--yes`; your contract never sees those flags.

```ts
defineMutation({
  // ...same base fields, plus:
  idempotency: { kind: "conditional", parameter: "ifNotExists" },  // or "always" | "none"
  planSchema: CreatePlan,                // the plan is encoded and hashed into the token
  plan: (input) => ...,                  // read-only: derive a SELF-CONTAINED plan
  apply: (plan) => ...,                  // executes ONLY the confirmed plan — no input
  renderPlanText: (plan) => "will ...",  // human preview
})
```

`apply` never sees the original input: anything that changes what apply does must live in the plan, because the confirmation token binds `{command, schemaVersion, plan}` and nothing else. Model conditional no-ops (like `--if-not-exists` on an existing resource) as a plan variant. `plan` runs with read capabilities (`StoreReader`); `apply` gets write capabilities (`StoreWriter`) — writing during planning does not typecheck.

Rules enforced mechanically (type system where possible, contract-invariant tests otherwise):

- Framework flags (`--dry-run`, `--confirm`, `--yes`, `--fields`) and error codes are added by the runtime and appear in `describe` automatically — never redeclare them. Reserved aliases: `h`, `v`, `y`.
- Choice params declare `choices`; boolean flags cannot have defaults; arguments take no alias/default. All of these fail `tsc` (see `test/contract/type-fixtures.ts`).
- Contradictory controls (`--dry-run` with `--yes`/`--confirm`) are rejected by the runtime before planning.

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

Always set `fix` to an exact command or action, e.g. `` fix: `re-run with --if-not-exists` ``. Add a new code by adding one row to `ERROR_CATALOG` in `src/errors.ts` — the constructor, `ErrorCode` type, exit mapping, and describe output all derive from that table.

## Services

Handlers reach the world through services (`src/services/`), never `node:fs` or `process` (lint blocks both). Define a service with `Context.Service`, give it a production `layer`, and provide it in `src/bin.ts`. Tests provide fake layers — see `test/unit/task-create.test.ts`.
