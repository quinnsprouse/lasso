# Lasso 🪢

Rope your commands. Arm your agents. Ship with proof.

An opinionated starter kit for CLIs whose primary user is an AI agent — the agent that edits this repository and the agent that runs the installed binary. Built on Effect v4 with a contract layer that turns protocol violations into build failures.

Requires Node 22.18 or newer (24 LTS recommended), npm 10 or newer, and Git. Tested on Linux and macOS.

## Quick Start

```bash
npx degit <you>/lasso my-cli
cd my-cli
git init --initial-branch=main
npm ci
npm run setup                    # install git hooks
node scripts/rename.mjs my-cli   # take your name everywhere
npm run dev -- task list --json
```

Rename before you publish. The name `lasso` is taken on npm, and the trusted publisher on npmjs.com is configured per package name.

## Make It Yours

Point `repository` in `package.json` at your repo — npm provenance verifies it against the workflow origin. Then replace the demo `task` domain: scaffold commands with `node scripts/new-command.mjs <group> <name>`, and delete `src/commands/task-*.ts`, `src/domain/`, and `src/services/store.ts` when you no longer need the example.

## Daily Commands

```bash
npm run dev -- <args>  # run from source
npm run check          # Fast Profile: format, lint, types, diagnostics, unit tests
npm run check:push     # Push Profile: check + build, dead code, e2e, pack smoke
npm run check:ci       # CI Profile: push + coverage + Starter Contract
npm run build          # bundle dist/bin.cjs (self-contained, zero runtime deps)
npm run test:contract  # replay the Starter Contract locally
npm run setup          # install hooks after a late git init
```

## The Machine Protocol

Agents read stdout; humans read stderr. Every invocation ends in exactly one result:

```json
{ "schemaVersion": "1", "status": "ok", "data": {}, "warnings": [] }
```

- Errors carry a stable `code`, an executable `fix`, and a `transient` flag that tells the caller whether to retry.
- Exit codes are semantic: 4 confirmation required, 64 usage, 65 data, 73 conflict, 75 transient, 130 interrupted.
- Mutations run plan → confirm → apply. An unconfirmed mutation exits 4 with the plan and a replayable `confirmArgs` array. Every mutation gets `--dry-run` and `--yes` from the contract type.
- `mycli describe --json` and `mycli schema --json` replace help-text parsing.

The full protocol lives in [docs/agents/PROTOCOL.md](docs/agents/PROTOCOL.md).

## Feedback Loop

Verification is defined once, in `scripts/verify.mjs`:

1. `npm run check` runs the **Fast Profile**: format, lint, types, Effect diagnostics, and unit tests. Under 5 seconds.
2. `npm run check:push` runs the **Push Profile**: Fast plus build, dead code, e2e against `dist`, and a pack smoke test.
3. `npm run check:ci` runs the **CI Profile**: Push plus coverage and the Starter Contract.

Lefthook owns the Git hook seam:

- **pre-commit**: format and lint staged files
- **commit-msg**: commitlint enforces Conventional Commits
- **pre-push**: `npm run check:push`

Local and CI run identical commands, so local green means CI green.

## Starter Contract

`npm run test:contract` copies `git archive HEAD` into a temp directory and proves every advertised guarantee: lockfile-exact install, working hooks, a bootable build, the JSON protocol, the confirmation flow, a generator round-trip, a full rename and back, and a clean pack. Failures preserve the temp directory as evidence.

## Stack

- [Effect](https://effect.website) v4 (exact-pinned beta) — typed errors, Schema, services, `effect/unstable/cli`
- TypeScript 7 (strict) + [oxlint](https://oxc.rs) type-aware + [Biome](https://biomejs.dev) format
- [tsdown](https://tsdown.dev) → one self-contained CJS bundle
- [Vitest](https://vitest.dev) + execa + fast-check
- [lefthook](https://lefthook.dev) + commitlint + [knip](https://knip.dev)

## Key Conventions

- **Commands are contracts** — `defineQuery`/`defineMutation`; one adapter file imports the parser. Lint enforces this.
- **Mutations plan before they apply** — the runtime owns `--dry-run`, `--confirm`, `--yes`; plans are deterministic, and the confirmation token binds them.
- **stdout is data** — only the renderer writes it. Lint blocks `process` and `console` everywhere else.
- **The surface changes additively** — never rename commands, flags, exit codes, or envelope fields.

## Project Layout

```
src/
  bin.ts        # process boundary: the only Effect.run* and process access
  runtime.ts    # exit settlement, shared with tests
  contract/     # defineQuery/defineMutation, surface, parser adapter, tokens
  output/       # format negotiation, outcome renderer, envelopes, exit codes
  commands/     # contracts + the roster (index.ts)
  services/     # capability services (StoreReader, StoreWriter)
  domain/       # demo task domain
test/
  unit/         # handlers through fake layers
  contract/     # protocol invariants + in-process runtime matrix
  e2e/          # execa against dist/bin.cjs
scripts/        # verify profiles, generators, Starter Contract
docs/agents/    # progressive-disclosure references
```

## AI Agent Docs

- `AGENTS.md` is the entry point (minimal, links to detailed docs). `CLAUDE.md` is symlinked to it.
- `CONTEXT.md` defines the domain language: CommandContract, Output Protocol, Verification Profiles, Starter Contract.
- Detailed guidance lives in `docs/agents/`. Effect ships its own agent docs in `node_modules/effect/AGENTS.md`.

## License

MIT
