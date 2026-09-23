# Changelog

The machine surface is additive-only. Each entry names a user-visible change; a breaking change names the `schemaVersion` bump and the migration. The repository's `test/contract/surface.snapshot.json` records the exact surface at every tag.

## Unreleased

- `interrupted` now also ends a run stopped by SIGTERM (what agent harnesses and CI send on a timeout), with the same terminal envelope or event as SIGINT; a second signal exits at once.
- Exactly one terminal outcome, always: a signal that lands while the terminal envelope is being written no longer adds an `interrupted` envelope after it, and a closed stdout keeps the outcome's exit code (a confirmation stays 4). A run that can never finish ends as `internal_error`, exit 70, instead of exiting 0 silently.
- A mistyped command or flag offers the corrected invocation as the first `next` move when it parses (`did you mean "list"?`); a guessed mutation previews rather than applies. The parser no longer prints a second copy of usage errors on stderr.
- A flag given twice is a usage error, including `--yes --no-yes` (which used to apply). A `--confirm` value that is not a token is `invalid_usage`.
- Under `--confirm`, only a data change (`resource_conflict`, `not_found`, `invalid_data`) reports as `stale_confirmation`; an unreadable store or an outage keeps its own code, exit, and `fix`.
- Text mode: parser output honors `TERM=dumb` and `CI`, and logs go to stderr in every format. An empty `LASSO_FORMAT` counts as unset; `--format auto` defers to a concrete format.
- Mutations: `apply` receives the plan decoded from the exact JSON the token hashed.
- Faster: the bundle is minified (names kept for debugging, 1.2 MB → 465 KB) and the launcher enables Node's compile cache, which halves the CLI's startup overhead; NDJSON collections are written in one pass, twice as fast at 50,000 items.
- Demo: `task create` plans record `ifExists`, so `--if-not-exists` stays a no-op when another writer wins the race; ids normalize Unicode (NFC) and never end in `-` after truncation.
- Demo store: a lock left behind by a killed process now fails as non-transient `cannot_write`, with the removal command in `fix`, instead of a `transient_failure` that no retry could clear. A writer waiting on a held lock can be interrupted. Fields this version does not know are rejected as `invalid_config` instead of dropped on the next write; unreadable stores report `invalid_config`, not `cannot_write`; a failed write leaves no temp file.

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
