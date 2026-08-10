# Effect patterns

This kit uses Effect v4 (beta, exact-pinned). The package ships its own agent docs: read `node_modules/effect/AGENTS.md` and the compile-checked examples in `node_modules/effect/ai-docs/src/` when you need API details. The `effect-tsgo` diagnostics in the Fast profile catch most misuse mechanically — trust the gate.

## The approved patterns

Use these seven shapes; they cover everything the demo commands do.

1. **Tagged expected error** — `Errors.*` constructors (src/errors.ts). Never `throw`, never a plain `Error` in a handler.
2. **Wrap a promise** — `Effect.tryPromise({ try, catch })`, mapping `catch` to an `AppError`.
3. **Retry transient work** — `Effect.retry(effect, { schedule })` only on effects whose failures set `transient: true`. Never unbounded.
4. **Scoped resource** — `Effect.acquireRelease` inside `Effect.scoped`; release runs on interrupt too.
5. **Layer-injected service** — `class X extends Context.Service<X, Api>()("id") { static layer = … }`; tests use `Layer.succeed(X, X.of({ … }))`.
6. **Generator handlers** — `Effect.gen(function* () { const x = yield* Service; … })`. `yield*` a tagged error directly to fail (no `Effect.fail` wrapper needed).
7. **Clock, not Date** — `yield* Clock.currentTimeMillis`; tests control time via the test clock.

## Banned

Lint and diagnostics enforce most of these; the rest are review policy.

- `Effect.run*` anywhere except `src/bin.ts`.
- `orDie` in command code, except on Renderer writes (a broken stdout is not recoverable).
- Broad `catchAll` that erases error types — catch specific tags.
- Direct `process`, `console`, `node:fs`, global `fetch`, or `new Date()` in commands — use services.
- `unknown` data crossing into domain code without a Schema decode.
