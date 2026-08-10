# Lasso 🪢

Build agent-first CLIs with Effect.

Each command is one contract that generates its parsing, help, schemas, and docs. Mutations plan before they apply, and the runtime owns confirmation. Outside a terminal, Lasso writes machine output by default and catches protocol drift in the checks.

## Quick start

Use Node 22.18 or newer, npm 10 or newer, and Git.

```bash
npx degit quinnsprouse/lasso my-cli
cd my-cli
git init --initial-branch=main
npm ci
npm run setup
node scripts/rename.mjs my-cli
npm run dev -- task list --json
```

Rename the package before publishing because `lasso` is taken on npm. Set `repository` in `package.json` to match the GitHub repository for provenance.

## What makes it different

In JSON mode, Lasso writes one envelope to stdout for each invocation. It sends diagnostics to stderr.

```json
{"schemaVersion":"1","status":"ok","data":{},"warnings":[]}
```

- Expected errors include a stable `code`, an executable `fix`, and a `transient` flag.
- Every mutation begins with a read-only plan. The runtime owns `--confirm`, `--dry-run`, and `--yes`.
- Exit code 4 requests confirmation. Exit code 75 and `transient: true` mean a retry may work.
- `describe --json` lists every command. `schema --json` returns JSON Schema draft 2020-12.

Read the [output protocol](docs/agents/PROTOCOL.md) for envelopes, NDJSON, exit codes, and confirmation.

## Daily commands

```bash
npm run dev -- <args>                        # run from source
npm run check                                # format, lint, types, diagnostics, unit tests
npm run check:push                           # add build, dead code, e2e, and pack checks
npm run check:ci                             # add coverage and the Starter Contract
npm run build                                # build dist/bin.cjs
npm run test:contract                        # test a fresh archive of the starter
node scripts/new-command.mjs <group> <name>  # scaffold and register a command
npm run setup                                # install Git hooks
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