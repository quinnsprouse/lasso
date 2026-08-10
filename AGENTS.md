Agent-first CLI starter kit: Effect v4 + effect/unstable/cli behind a kit-owned CommandContract. Machine output by default; guardrails fail mechanically.

- Quality gate: `npm run check` (format + type-aware lint + types + Effect diagnostics + unit tests, <20s)
- Push gate: `npm run check:push` (check + build + knip + e2e against dist + pack smoke)
- CI gate: `npm run check:ci` (push + coverage + Starter Contract)
- New command: `node scripts/new-command.mjs <group> <name>` — scaffolds a contract, registers it, leaves Fast green
- Try it: `npm run dev -- task list --json`
- Hook recovery after `git init`: `npm run setup`

## Rules

1. Commands are **contracts** (`defineQuery`/`defineMutation` in `src/commands/`), never raw parser code. Only `src/contract/adapter.ts` imports `effect/unstable/cli`; only `src/bin.ts` touches `process`. Lint enforces both.
2. Mutations declare `plan` and `apply` separately. The runtime owns `--dry-run`, `--confirm`, `--yes` — never reimplement them.
3. Every expected failure is an `AppError` from `Errors.*` with a `fix` the caller can execute. Unhandled error types do not typecheck.
4. Only the Renderer writes stdout. Diagnostics go to stderr.
5. The CLI surface is frozen additively: never rename commands, flags, exit codes, or envelope fields — agents and models cache them.

## Progressive Disclosure

Open these only when relevant:

- [Domain language](CONTEXT.md) — CommandContract, Output Protocol, Verification Profiles, Starter Contract
- [Architecture decisions](docs/adr/README.md) — load-bearing decisions, concise format
- [Adding commands](docs/agents/COMMANDS.md) — contract fields, params, error taxonomy, worked examples
- [Output protocol](docs/agents/PROTOCOL.md) — envelopes, exit codes, NDJSON, confirmation flow
- [Effect patterns](docs/agents/EFFECT.md) — the approved patterns and banned escape hatches; see also `node_modules/effect/AGENTS.md`
- [Testing](docs/agents/TESTING.md) — fake layers, e2e against dist, invariants

## Commits

Conventional Commits enforced by commitlint. `type(scope): description`.
