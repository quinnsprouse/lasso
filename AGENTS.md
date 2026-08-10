Agent-first CLI starter kit: Effect v4 + effect/unstable/cli behind a kit-owned CommandContract. Machine output by default; guardrails fail the build, not the user.

- Quality gate: `npm run check` (format + type-aware lint + types + Effect diagnostics + unit tests, <5s)
- Push gate: `npm run check:push` (check + build + dead code + e2e against dist + pack smoke)
- CI gate: `npm run check:ci` (push + coverage + Starter Contract)
- New command: `node scripts/new-command.mjs <group> <name>` (scaffolds, registers, Fast stays green)
- Try it: `npm run dev -- task list --json`
- Hook recovery after `git init`: `npm run setup`

Put disposable experiments in `.scratch/` or the OS temp directory, never the repository root.

## Rules

1. Commands are contracts (`defineQuery`/`defineMutation`), never raw parser code. Only `src/contract/adapter.ts` imports the parser; only `src/bin.ts` touches `process`. Lint enforces both.
2. Mutations are `plan` + `apply`. The runtime owns `--dry-run`, `--confirm`, `--yes`.
3. Expected failures are `Errors.*` AppErrors with an executable `fix`.
4. Only the Renderer writes stdout; diagnostics go to stderr.
5. The surface changes additively only — never rename commands, flags, exit codes, or envelope fields.

## Progressive Disclosure

Open these only when relevant:

- [Domain language](CONTEXT.md) — CommandContract, Output Protocol, Verification Profiles, Starter Contract
- [Adding commands](docs/agents/COMMANDS.md) — contract fields, params, error taxonomy
- [Output protocol](docs/agents/PROTOCOL.md) — envelopes, exit codes, NDJSON, confirmation flow
- [Effect patterns](docs/agents/EFFECT.md) — approved patterns, banned escape hatches, `node_modules/effect/AGENTS.md`
- [Testing](docs/agents/TESTING.md) — fake layers, e2e against dist, invariants

## Commits

Conventional Commits enforced by commitlint. `type(scope): description`.
