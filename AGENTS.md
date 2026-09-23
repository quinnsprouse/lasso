# Lasso agent guide

Agent-first CLI starter kit: Effect v4 and `effect/unstable/cli` behind a kit-owned CommandContract. Machine output is the default; contract violations fail mechanical gates, not the user.

## First turn

```bash
npm ci                          # exact toolchain from the lockfile
npm run setup                   # git hooks (after a fresh clone or a late git init)
npm run doctor -- --json        # workspace health; every reported problem carries a fix
npm run dev -- task list --json # run from source
```

Node ^22.19, ^24.11, or 26 and newer (the dev toolchain's range; the shipped CLI runs on any Node 22.19 or newer), npm 10 or newer. Disposable experiments go in `.scratch/` or the OS temp directory, never the repository root.

Replace the demo in `src/domain/`, `src/commands/task-*.ts`, `src/services/store.ts`, and `src/services/feed.ts`, and its rows in `src/settings.ts`. Keep `src/services/http.ts`: it maps HTTP failures to the error catalog for any API service. Update service wiring in `src/services/index.ts` and command registration in `src/commands/index.ts`. Replace the task-specific unit and command tests, `test/fixtures/mutations.ts`, the demo services in `test/contract/harness.ts`, and the task journeys in the e2e suite and `scripts/starter-contract.mjs`. The demo also includes `guides/topics/`, the router rows in `skills/lasso/SKILL.md`, and the `.lasso/` state directory.

Keep the contract definitions, parser adapter, output protocol, and reusable checks. [Testing](docs/agents/TESTING.md) explains how to supply fixtures for replacement commands.

## Verification

- `npm run check` — Fast: format, type-aware lint with Effect and Vitest rules, types, guide-catalog freshness, unit and contract tests. Seconds.
- `npm run check:push` — Push: Fast plus build, dead code, e2e against `dist`, and packed-package smoke. The pre-push hook runs this.
- `npm run check:ci` — CI: Push plus coverage and the Starter Contract (`npm run test:starter`; needs a commit, it archives HEAD).
- One test file: `node node_modules/vitest/vitest.mjs run test/unit/token.test.ts` (`npx vitest` is refused: unpinned executor). E2E needs `npm run build` first.
- Debug from source: `node --inspect-brk src/bin.ts <args>`; the shipped artifact: `npm run build && node --inspect-brk dist/bin.cjs <args>`.

Never skip, focus, or `.todo` a test to get green; Vitest lint rules fail the Fast profile on any of them (including `it.effect.skip`), and `allowOnly: false` rejects focused tests even when run directly. Likewise, never loosen a lint rule, threshold, or compiler option to get green, and give every suppression a `-- reason` (a test enforces it); the guard asks a person to approve edits to check configuration. When the post-edit hook reports a failure, repair the file it names and run `npm run check`. When it reports an incomplete toolchain, run `npm ci`. When the Stop hook reports the tree is red, fix that before finishing.

## Rules

1. Commands are contracts (`defineQuery` / `defineMutation`), never raw parser code. Only `src/contract/adapter.ts` imports the parser. Direct `process` access is confined to `src/bin.ts` and the adapter's stderr console bridge; lint enforces those per-file boundaries.
2. Mutations are `plan` + `apply`. The runtime owns `--dry-run`, `--confirm`, and `--yes`. Plans are deterministic, JSON-round-trippable, self-contained, and read-only; `apply` receives only the confirmed plan and the write capabilities. Every mutation supplies explicit input and read-service fixtures in `test/fixtures/mutations.ts`; the shared assertion compares plans under different clocks.
3. Expected failures are built through `Errors.*` in `src/errors.ts`; those factories require an executable `fix`, and the runtime maps exit and transience from the catalog, never from the error instance.
4. `renderOutcome` in `src/output/outcome.ts` is the single definition of the wire format. The Renderer emits command and machine-mode version output inside Effect; `src/bin.ts` writes settled failures at the process boundary. In machine formats, diagnostics and stray Effect `Console` output go to stderr; `Console` is lint-banned in `src/` outside the process-boundary exceptions (`src/bin.ts`, the adapter console bridge).
5. Guidance is one vocabulary on every terminal outcome: `error.fix` (required), `next` (executable argv, validated against the surface, at most three), `guides` (topic ids). Guides live in `guides/topics/*.md`, inlined into the bundle by `node scripts/guides.mjs`; a topic exists only for knowledge the surface cannot express. See [docs/agents/GUIDANCE.md](docs/agents/GUIDANCE.md).
6. Preserve compatibility for published commands and output. `test/contract/surface.snapshot.json` records `describe` and `schema`; `npm run check` fails on any unrecorded change. Review the snapshot diff for compatibility. Before the first release, replace the demo freely.

## Changing the surface

Add a command with the generator. It scaffolds, registers, formats, and records the snapshot in one transaction; `--mutation` also adds the required plan fixture:

```bash
node scripts/new-command.mjs <group> <name>              # query
node scripts/new-command.mjs <group> <name> --mutation   # plan + apply
npm run check
```

For a mutation, implement `plan` (read services) and `apply` (write services), set `idempotency`, then extend the generated case in `test/fixtures/mutations.ts` with one case per plan branch and expected error. Add a unit test through fake layers (`test/unit/task-create.test.ts` is the pattern) and a happy-path plus a failure e2e case, then `npm run surface:update`. The generator prints these steps.

A new or edited guide topic: edit `guides/topics/<topic>.md`, run `node scripts/guides.mjs`, optionally declare it on a contract (`guides: [...]`), then record the surface change as below.

Any other additive change (new flag, error code, schema field):

```bash
npm run surface:update
git diff -- test/contract/surface.snapshot.json   # the diff is the review
npm run check
```

`npm run surface:update` records the current definitions without classifying changes as safe or breaking. Review the diff before committing. A breaking change to a published CLI also bumps `SCHEMA_VERSION` in `src/output/envelope.ts` and documents the migration.

To add an expected error code: add the `ERROR_CATALOG` row and the `Errors.*` factory in `src/errors.ts` (and list it in `STATE_CODES` when it means the data a plan read has changed), add the row to the table in `docs/agents/COMMANDS.md` (the invariants parse it), declare the code in each producing contract's `domainErrorCodes`, then `npm run surface:update`.

## Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md`; for API details use `node_modules/effect/ai-docs/src`, which matches the installed version. `effect`, `@effect/platform-node`, and `@effect/vitest` are exact-pinned to the same release candidate; generic `effect@beta` or `effect@latest` (v3) install instructions never override those pins. Use `Effect.fn("name")(function* …)` for handlers, plans, applies, and service methods that return generator effects; a handler with no services and no failure may return `Effect.succeed` or `Effect.sync` directly. Reach the world through services, never `node:fs`, `process`, global `fetch`, `Date`, or Effect `Console`. Read settings from `src/settings.ts` (Effect `Config`, secrets as `Redacted`, published by `describe`), and call APIs through `HttpClient` with failures mapped by `httpFailure`; `src/services/feed.ts` is the pattern.

## Claude Code guards

`.claude/hooks/` backs the rules while you work; details in [docs/agents/GUARDS.md](docs/agents/GUARDS.md).

- `guard.mjs` checks direct commands for common hook bypasses, destructive git operations, unpinned tool execution, and deletion of git metadata or the lockfile. It protects generated files from Edit/Write, and asks a person to approve edits to check configuration (lint, types, tests, hooks, CI). It does not interpret shell programs; see GUARDS.md for its scope.
- `post-edit.mjs` formats edited files and lints scripts. Effect rules run with lint. An edited guide topic regenerates the catalog. Full project typechecking after each TypeScript edit is opt-in with `LASSO_POST_EDIT_FULL=1`; `npm run check` always runs it.
- `settings.json` pre-approves the verification and generator commands and denies reading `.env` files.
- `session-start.mjs` prints the doctor's failing checks (or one healthy line); `stop-check.mjs` runs the Fast profile when the tree is dirty and refuses to end the turn while it is red.

Scripts and the post-edit hook resolve every tool through `scripts/lib/toolchain.mjs`; the git hooks invoke pinned `node_modules` entries directly; the session and stop hooks invoke repository scripts. Nothing runs through `npx`.

## References

Open these only when relevant:

- [Domain language](CONTEXT.md) — CommandContract, Output Protocol, Verification Profile, Surface Snapshot, Starter Contract, Agent Guards
- [Adding commands](docs/agents/COMMANDS.md) — fields, params, the error table, services
- [Output protocol](docs/agents/PROTOCOL.md) — envelopes, exit codes, NDJSON, confirmation
- [Effect patterns](docs/agents/EFFECT.md) — approved patterns, banned escape hatches
- [Testing](docs/agents/TESTING.md) — fake layers, invariants, compatibility, e2e
- [Guidance](docs/agents/GUIDANCE.md) — the four layers, writing a topic, emitting next moves, the shipped skill
- [Claude guards](docs/agents/GUARDS.md) — events, file matrix, exit behavior, recovery

## Commits

Commitlint extends `@commitlint/config-conventional`: `type: description` or `type(scope): description`, header at most 100 characters, types `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.
