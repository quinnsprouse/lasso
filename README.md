# Lasso 🪢

Build agent-first CLIs with Effect.

Each command is one contract that generates its parsing, help, schemas, and docs. Mutations plan before they apply, and the runtime owns confirmation. Outside a terminal, Lasso writes machine output by default and catches protocol drift in the checks.

## Quick start

Use Node 22.19 or newer, npm 10 or newer, and Git.

```bash
npx degit quinnsprouse/lasso my-cli   # or: gh repo create my-cli --template quinnsprouse/lasso --clone
cd my-cli
git init --initial-branch=main        # skip when gh created the repository
npm ci
npm run setup
node scripts/rename.mjs my-cli
npm run dev -- task list --json
```

Rename the package before publishing: the template's npm name is under the author's scope. Then set `name` (your scope), `repository`, `homepage`, and `bugs` in `package.json`; provenance requires `repository` to match your GitHub project. The demo store lives in `.lasso/` (renamed with the CLI) under the current directory.

## What makes it different

In JSON mode, Lasso writes one envelope to stdout for each invocation. It sends diagnostics to stderr.

```json
{"schemaVersion":"1","status":"ok","data":{},"warnings":[],"next":[],"guides":[]}
```

- Expected errors include a stable `code`, an executable `fix`, and a `transient` flag.
- Every mutation begins with a read-only plan. The runtime owns `--confirm`, `--dry-run`, and `--yes`.
- Exit code 4 requests confirmation. `transient: true` means a retry may work (exits 69, 75, and 130 carry it).
- `describe --json` lists every command. `schema --json` returns JSON Schema draft 2020-12.
- Every outcome carries `next` (executable next moves) and `guides` (topic ids); `guide get <topic>` serves version-matched guides for what the surface cannot express, and `skills/` ships the skill that routes agents to them.
- A committed snapshot makes command and schema changes visible in review. Tests require the snapshot to stay current; reviewers decide compatibility.
- Claude Code hooks in `.claude/` check direct commands and report formatting and lint errors after edits. Full type and Effect checks after each edit are opt-in.

Read the [output protocol](docs/agents/PROTOCOL.md) for envelopes, NDJSON, exit codes, and confirmation.

## Daily commands

```bash
npm run dev -- <args>                        # run from source
npm run check                                # format, type-aware lint, types, guide catalog, unit and contract tests
npm run check:push                           # add build, dead code, e2e, and pack checks
npm run check:ci                             # add coverage and the Starter Contract
npm run build                                # build dist/bin.cjs
npm run test:starter                         # test a fresh archive of the starter
node scripts/new-command.mjs <group> <name>  # scaffold and register a command
node scripts/guides.mjs                      # inline guides/topics/*.md into the bundle
npm run surface:update                       # record an additive surface change
npm run setup                                # install Git hooks
npm run doctor                               # check the workspace, incl. patch state
npm run release:prepare -- patch             # bump every version source together
```

Agents start with [AGENTS.md](AGENTS.md). [CONTEXT.md](CONTEXT.md) defines project terms, and [`docs/agents/`](docs/agents/) contains deeper references.

## Stack

- [Effect](https://effect.website) v4 beta with `effect/unstable/cli`
- TypeScript 7 with type-aware [oxlint](https://oxc.rs) and [Biome](https://biomejs.dev)
- [tsdown](https://tsdown.dev) with one self-contained CommonJS bundle
- [Vitest](https://vitest.dev), fast-check, and execa
- [lefthook](https://lefthook.dev), commitlint, and [knip](https://knip.dev)

## License

[MIT](LICENSE)
