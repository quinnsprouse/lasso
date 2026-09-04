# Changelog

The machine surface is additive-only. Each entry names a user-visible change; a breaking change names the `schemaVersion` bump and the migration. The repository's `test/contract/surface.snapshot.json` records the exact surface at every tag.

## 0.1.0

Initial release.

- CommandContract: one `defineQuery` / `defineMutation` declaration generates the parser, help, `describe`, JSON Schema, and the surface snapshot.
- Output protocol, `schemaVersion` `"1"`: `ok`, `error`, and `confirmation_required` envelopes; NDJSON events `item`, `warning`, `progress`, `summary`, `confirmation_required`, `error`; format negotiation through `--json`, `--format`, `LASSO_FORMAT`, and TTY detection; exit codes 0, 4, 64, 65, 69, 70, 73, 75, 77, 78, 130.
- Errors: a catalog of codes with exit and `transient`; every error carries an executable `fix`.
- Mutations: plan/apply with confirmation tokens, `--dry-run`, `--confirm <token>`, `--yes`; `stale_confirmation` when a replay no longer matches; `interrupted` ends an interrupted run with a terminal envelope or event.
- Point-of-use guidance: `next` and `guides` on every terminal envelope and terminal event.
- Introspection: `describe --json`, `describe --command "<name>" --json`, `schema --json` (JSON Schema draft 2020-12); `--help` in a machine format answers with the `describe` payload.
- Guide catalog: `guide list` and `guide get <topic> [--brief]`, version-matched and offline.
- Demo domain: `task list`, `task create` (`--if-not-exists`), `task audit`, stored in `.lasso/tasks.json` under the current directory.
- Shipped skill: `skills/lasso/SKILL.md` in the published package.
