# Lasso 🪢

An agent-first CLI starter kit. The machine surface — JSON envelopes, semantic exit codes, a structured confirmation protocol, runtime introspection — is the default; the human TTY experience is the fallback. Built whole-app on [Effect](https://effect.website) v4 with a contract layer that makes protocol violations fail the build, not the user.

Requires Node 22.18+ (24 LTS recommended), npm 10+, and Git.

## Quick start

```bash
npx degit <you>/lasso my-cli
cd my-cli
git init --initial-branch=main
npm ci
npm run setup                      # installs git hooks
node scripts/rename.mjs my-cli     # make it yours (required before publishing:
                                   # "lasso" is taken on npm, and the trusted
                                   # publisher is configured per package name)
npm run dev -- task list --json
```

Before the first publish, also point `repository` in package.json at your repo — npm provenance verifies it against the workflow's origin.

## Why this kit

**Agents are the primary user.** Every design decision follows from that:

- **One envelope, everywhere.** `{ schemaVersion, status, data | error, warnings }` on stdout; diagnostics on stderr; JSON automatically when stdout is not a TTY. Errors carry a machine `code`, an executable `fix`, and a `transient` flag so a caller knows whether to retry or change course.
- **Semantic exit codes.** 4 = confirmation required, 64 usage, 65 data, 69 unavailable, 73 conflict, 75 transient, 77 auth, 78 config, 130 interrupted. Frozen, additively.
- **Mutations are plan → confirm → apply.** An unconfirmed mutation exits 4 with the plan and a `confirmArgs` array; the token hash-binds the plan, so nothing ever applies that wasn't previewed. `--dry-run` and `--yes` come free with every mutation — structurally, from the contract type.
- **Runtime introspection.** `mycli describe --json` and `mycli schema --json` (JSON Schema 2020-12) replace help-text parsing. `--help --json` answers with the same payload.
- **Guardrails that fail mechanically.** Typed error channels, Schema-validated output, contract-invariant tests, type-aware oxlint, Effect language-service diagnostics, and a lint-enforced renderer monopoly on stdout — all in a sub-4-second `npm run check`.

## Daily commands

```bash
npm run dev -- <args>   # run from source
npm run check           # Fast profile: format, lint, types, diagnostics, unit tests
npm run check:push      # + build, dead code, e2e against dist, pack smoke (pre-push hook)
npm run check:ci        # + coverage, Starter Contract (CI)
node scripts/new-command.mjs <group> <name>   # scaffold a command, Fast stays green
npm run build           # bundle dist/bin.cjs (self-contained, zero runtime deps)
```

## The shape of a command

Commands are contracts; the parser, help, `describe`, JSON Schema, and docs are generated from them. See `docs/agents/COMMANDS.md` for the full reference:

```ts
export const taskList = register(
  defineQuery({
    name: "task list",
    summary: "List tasks",
    params: { status: { kind: "flag", type: "choice", choices: ["open", "done", "all"], default: "open", description: "Filter tasks by status" } },
    output: TaskList,
    handler: (input) => Effect.gen(function* () { /* services in, data out */ }),
    // …
  }),
)
```

## Verification

Three nested profiles, defined once in `scripts/verify.mjs`; the pre-push hook and CI run the identical commands. The **Starter Contract** (`npm run test:contract`) replays the whole fresh-clone journey — install, hooks, build, protocol behavior, generator round-trip, pack hygiene — from a clean `git archive` in a temp dir.

## Stack

Effect 4 (beta, exact-pinned) · effect/unstable/cli behind a kit-owned adapter · TypeScript 7 · oxlint (type-aware) · Biome (format) · tsdown → self-contained CJS · Vitest 4 + execa + fast-check · lefthook + commitlint · knip

## Docs

`AGENTS.md` is the agent entry point (CLAUDE.md symlinks to it). Progressive disclosure in `docs/agents/`; load-bearing decisions in `docs/adr/`; domain language in `CONTEXT.md`.

## License

MIT
