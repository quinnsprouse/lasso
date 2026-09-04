# Effect patterns

This kit uses Effect v4 (beta, exact-pinned). The package ships its own agent docs: read `node_modules/effect/AGENTS.md` and the compile-checked examples in `node_modules/effect/ai-docs/src/` when you need API details — they match the installed version, unlike web docs.

Misuse is caught mechanically at three points: about 80 `effecttsgo/*` oxlint rules (extended from `@effect/tsgo` presets in `.oxlintrc.json`), the `effect-tsgo diagnostics` step in every profile, and the post-edit hook, which formats and lints each edited script file and optionally runs full typechecking and file-scoped diagnostics when `LASSO_POST_EDIT_FULL=1`. Trust the gates.

`effect` and `@effect/platform-node` are exact-pinned to the same beta in `package.json` and move together only during a deliberate, separately verified upgrade; never run a generic `effect@beta` install here.

## The approved patterns

Use these seven shapes; they cover everything the demo commands do.

1. **Tagged expected error** — `Errors.*` constructors (src/errors.ts). Never `throw`, never a plain `Error` in a handler.
2. **Wrap a promise** — `Effect.tryPromise({ try, catch })`, mapping `catch` to an `AppError`.
3. **Retry transient work** — `Effect.retry(effect, { schedule })` only on effects whose failures set `transient: true`. Never unbounded.
4. **Scoped resource** — `Effect.acquireRelease` inside `Effect.scoped` when the resource outlives one step; `Effect.acquireUseRelease` for a single guarded use (the store lock). Release runs on interrupt too.
5. **Layer-injected service** — `class X extends Context.Service<X, Api>()("id") { static layer = … }`; tests use `Layer.succeed(X, X.of({ … }))`.
6. **Generator functions** — `Effect.gen(function* () { … })` for a standalone effect; `Effect.fn("name")(function* …)` for any function that returns a generator effect — handlers, plans, applies, service methods — as Effect's own guide recommends. `yield*` a tagged error directly to fail (no `Effect.fail` wrapper needed). A handler with no services and no failure may be a plain `Effect.succeed`/`Effect.sync`.
7. **Effect time, not `Date`** — `yield* Clock.currentTimeMillis` for the current time and `DateTime` for construction, parsing, and formatting. Tests pin the Clock service (the plan-determinism invariants run every plan under two different clocks).

## Banned

Lint and diagnostics enforce most of these; the rest are review policy.

- `Effect.run*` anywhere in `src/` except `src/bin.ts` (tests run effects with `Effect.runPromise` by design).
- `orDie` in command code, except on Renderer writes (a broken stdout is not recoverable).
- Broad `catchAll` that erases error types — catch specific tags.
- Direct `process`, `console`, `node:fs`, global `fetch`, or `new Date()` in commands — use services. Effect's `Console` is banned too (lint): narrate through `Progress`.
- `unknown` data crossing into domain code without a Schema decode.
