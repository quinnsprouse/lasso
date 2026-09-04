# Effect patterns

Use the docs shipped with the pinned Effect v4 beta. Read `node_modules/effect/AGENTS.md` first, then the relevant examples in `node_modules/effect/ai-docs/src/`. Upgrade `effect` and `@effect/platform-node` together, using exact versions.

## Patterns to copy

- Use `Errors.*` for expected command failures. Inside a generator, fail with `return yield* Errors.invalidData({ message, fix })`.
- Use named `Effect.fn("name")(function* …)` for handlers and service functions. Use `Effect.gen` for standalone effects such as layer construction. A function with no dependencies may return `Effect.succeed` or `Effect.sync` directly.
- Decode untrusted values with Schema before using them. Reuse decoder functions, and use `Schema.decodeUnknownEffect` inside Effect code. Map validation failures to an expected error when callers can recover.
- Wrap external promises with `Effect.tryPromise({ try, catch })`. Map the rejection to a typed error.
- Recover by tag with `Effect.catchTag`, or by a platform error's reason with `Effect.catchReason`. Do not swallow unrelated failures with `Effect.catch`.
- Bound retries by count or elapsed time and retry only recoverable failures. The store retries `error.reason._tag === "AlreadyExists"` for lock contention, but fails immediately on permission errors.
- Use `Effect.acquireRelease` inside `Effect.scoped`, or `Effect.acquireUseRelease` for a single guarded operation. Both release resources on interruption.
- Define services with `Context.Service` and provide layers at the application boundary. Tests replace them with `Layer.succeed(Service, Service.of({ … }))`.
- Use `Clock.currentTimeMillis` and `DateTime` for time. Keep time-dependent metadata out of mutation plans so confirmation tokens remain stable.

## Enforced boundaries

`.oxlintrc.json` extends the recommended `@effect/tsgo` preset. `npm run prepare` patches Oxlint; `npm run lint` runs its type-aware rules and fails on warnings. The doctor checks that a deliberately floating Effect triggers a diagnostic.

Effect recommends [reporting these diagnostics through Oxlint](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md). There is no separate diagnostics command. The post-edit hook runs the same lint rules, with full project typechecking available through `LASSO_POST_EDIT_FULL=1`.

- Commands use contracts. Only `src/contract/adapter.ts` imports the parser.
- Commands access the environment through services, not `process`, `node:fs`, global `fetch`, `Date`, or `Console`. Report progress through `Progress`.
- Effect runners, including the context-taking `*With` variants, are restricted to `src/bin.ts` and tests or tooling. Import `{ Effect }` from `"effect"` so the lint rules can check those calls.

Lint rejects unused suppression comments. Do not alias imports to evade a rule or suppress diagnostics to pass a check. Lint is not a security boundary. Keep `orDie` out of command handlers: expected failures must reach callers as typed errors. Renderer write failures are defects because a broken output stream cannot carry an error envelope.
