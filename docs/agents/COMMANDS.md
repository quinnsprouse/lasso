# Adding commands

Start with the generator — it scaffolds a query, registers it, formats, records the surface snapshot, and leaves the Fast profile green (the Starter Contract proves this on every CI run). For a mutation, generate the skeleton and replace `defineQuery` with `defineMutation` (AGENTS.md, "Changing the surface", lists the full steps):

```bash
node scripts/new-command.mjs task ping     # creates src/commands/task-ping.ts, registers it
npm run check
```

Then shape the contract. The type system and the tests named below enforce the mechanical rules; imperative summary wording is review policy. A new flag, code, or schema field is an additive surface change: run `npm run surface:update` and commit the snapshot (the generator already did this for the command itself).

## Queries

```ts
export const taskList = defineQuery({
  name: "task list",                   // "group leaf" or just "leaf"; two levels max
  summary: "List tasks",               // nonempty, ≤88 chars (tested); imperative (policy)
  stability: "stable",                 // or "experimental"
  params: {
    status: {                          // key is lowerCamelCase → CLI flag is --status
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
  guides: ["task-ids"],                // optional: topics an agent should read first (typed union of guides/topics/*.md)
  handler: Effect.fn("taskList.handler")(function* (input) { /* Effect<A, AppError, AppServices> */ }),
  next: ({ input, data }) => [          // optional: the next move(s) after a success, at most 3
    { message: "see it in the list", args: ["task", "list", "--json"] },
  ],
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
  apply: (plan) => ...,                  // receives the confirmed plan, decoded from its encoded form — no input
  renderPlanText: (plan) => "will ...",  // human preview
})
```

`apply` never sees the original input — anything that changes what apply does lives in the plan, because the token binds `{command, schemaVersion, plan}`. The runtime encodes the plan through `planSchema`, hashes and previews that encoded form, and hands `apply` its decoded value, so nothing the schema does not carry can reach `apply`. Plans are deterministic for identical state and input (replay recomputes and compares tokens), so apply-assigned metadata like timestamps stays out; model conditional no-ops as plan variants. Add explicit cases to `test/fixtures/mutations.ts`. The shared assertion plans each case twice against its supplied read services, changes the clock between runs, and compares encoded plans. Every registered mutation needs a successful case. Plans must round-trip through JSON: `NaN` and infinities are rejected at token time. `plan` gets read capabilities, `apply` gets write — crossing over does not typecheck. A no-op `apply` returns `null` from `StoreWriter.modify` so the store file keeps its identity.

Rules enforced mechanically (type system where possible, contract-invariant tests otherwise):

- Framework flags (`--dry-run`, `--confirm`, `--yes`, `--fields`) and error codes are added by the runtime and appear in `describe` automatically — never redeclare them. Reserved aliases: `h`, `v`, `y`.
- Choice params declare `choices`; boolean flags cannot have defaults; arguments take no alias/default. All of these fail `tsc` (see `test/contract/type-fixtures.ts`).
- Param keys are lowerCamelCase; summaries are at most 88 characters; every example starts with the bin name (invariant tests).
- Contradictory controls (`--dry-run` with `--yes`/`--confirm`) are rejected by the runtime before planning.

## Errors

Handlers fail only with `AppError` (the handler type enforces that); command code builds them through the `Errors.*` factories in `src/errors.ts` (review enforces that, and the runtime maps exit and transience from the catalog by code, so a hand-built error cannot invent either). Pick the code by meaning, not convenience — agents branch on it:

| Constructor | code | exit | transient |
|---|---|---|---|
| `Errors.invalidUsage` | invalid_usage | 64 | no |
| `Errors.invalidData` | invalid_data | 65 | no |
| `Errors.notFound` | not_found | 65 | no |
| `Errors.resourceConflict` | resource_conflict | 73 | no |
| `Errors.cannotWrite` | cannot_write | 73 | no |
| `Errors.serviceUnavailable` | service_unavailable | 69 | yes |
| `Errors.transientFailure` | transient_failure | 75 | yes |
| `Errors.authFailure` | auth_failure | 77 | no |
| `Errors.invalidConfig` | invalid_config | 78 | no |
| `Errors.staleConfirmation` | stale_confirmation | 64 | no |

The runtime alone produces `internal_error` (exit 70, a defect) and `interrupted` (exit 130, transient). This table is pinned by the `error catalog` invariants.

`Errors.*` also accept `next` (executable continuations) and `guides` (topics, for missing-MODEL failures; an error whose `fix` is complete declares none of its own and still inherits its command's). `fix` is required by the factory type and by the wire schema: an exact command or action, e.g. `` fix: `re-run with --if-not-exists` ``. To add an expected error code end to end: add the `ERROR_CATALOG` row and the explicit `Errors.*` factory in `src/errors.ts`, add the row to the table above (the `error catalog` invariants parse this table and check every factory against it), declare the code in each producing contract's `domainErrorCodes`, then run `npm run surface:update`. `ErrorCode`, the exit and transience lookup, and `describe` derive from the catalog; the named factory does not.

## Services

Handlers reach the world through services (`src/services/`), never `node:fs`, `process`, or Effect's `Console` (lint blocks all three; narrate through the `Progress` service). Define a service with `Context.Service`, give it a production `layer`, add it to the capability unions and merge its layer into `appServicesLayer` in `src/services/index.ts`. Tests provide fake layers — see `test/unit/task-create.test.ts`.
