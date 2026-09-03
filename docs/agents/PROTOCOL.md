# Output protocol

The machine surface is the default surface. stdout carries data; stderr carries diagnostics; the two never mix. Format negotiation happens before parsing: explicit `--format`/`--json` > `LASSO_FORMAT` env > auto (JSON when stdout is not a TTY, text on a terminal). Everything after a `--` terminator is left for the parser; conflicting explicit formats and invalid `LASSO_FORMAT` values are usage errors, never silently resolved. `NO_COLOR`, `TERM=dumb`, and `CI` disable color; non-TTY stdin, `--no-input`, or `CI` means no prompt may ever block. `--wizard` is refused when input is unavailable or negotiation selects a machine format; `--completions` is refused with an explicit machine format and otherwise emits a raw text script.

## Envelopes (json format)

Exactly one envelope per invocation on stdout, newline-terminated:

```json
{ "schemaVersion": "1", "status": "ok", "data": { }, "warnings": [] }
{ "schemaVersion": "1", "status": "error",
  "error": { "code": "resource_conflict", "message": "…", "fix": "…", "transient": false },
  "warnings": [] }
{ "schemaVersion": "1", "status": "confirmation_required", "plan": { },
  "confirmation": { "token": "plan_…", "confirmArgs": ["…"], "confirmCommand": "…" },
  "warnings": [] }
```

Every terminal envelope also carries `next` and `guides` (see Guidance below); both are always present, possibly empty. Fields are only ever added, so a consumer must ignore members it does not know; the published JSON Schemas describe the current version exactly, so validate against the schema fetched from the same binary version.

In JSON mode, expected errors also go to **stdout** (one parseable stream); the exit code still reports failure. A consumer that closes stdout early (`| head`) ends the run with exit 0 and nothing on stderr. `confirmArgs` is the canonical continuation — replay it verbatim; `confirmCommand` is display-only.

## Guidance

Three point-of-use primitives, one vocabulary, on every terminal outcome:

- **`error.fix`** — the one required recovery sentence on every error: an exact command or action.
- **`next`** — the agent's next move(s): `[{ "message", "args" }]`, where `args` is verbatim argv for this binary (no bin name), exactly like `confirmArgs`. Run it as-is. At most three, importance-ordered. The runtime owns the next moves of its own flows: a confirmation offers its replay, a dry run offers the confirmation flow (never a generated `--yes`), a stale token offers a fresh plan without `--confirm`, an interrupt offers a re-plan, a usage error offers `describe --json`, an unknown topic offers `guide list --json`. Contracts add their own after a success. Every emitted action is validated against the command surface; an invalid one is dropped into `warnings`, never turned into a failure.
- **`guides`** — importance-ordered guide topic ids for the model this outcome assumes. Only ids travel; fetch a body with `guide get <topic> --json` (or `--brief`). A command's declared topics are offered where the model matters — on its failures (a failure that declares none inherits them), confirmations, and dry runs — and advertised by `describe` (`guideTopics`, and `guides` per command); a plain success carries only `next`. Point-of-use outranks documents: an error whose `fix` is complete declares no topics of its own.

Text mode renders the same structure with fixed prefixes: `fix:`, `next: <message>: <bin> <args>`, `guide: <bin> guide get <topic>`.

## Exit codes

0 success · 4 confirmation required · 64 usage · 65 invalid data · 69 service unavailable · 70 internal defect · 73 cannot write/conflict · 75 transient (retry may work) · 77 auth · 78 config · 130 interrupted.

The one distinction to branch on hardest: `"transient": true` means a retry may work (exits 69, 75, and 130 carry it); everything else means change something first. Branch on the flag, not the exit code.

## NDJSON (`--format ndjson`)

One event object per line: `item`, `warning`, `progress`, `summary`, `confirmation_required`, `error`. Zero or more nonterminal `progress` events may precede the terminal: `{phase, message, completed?, total?}` where `phase` is kebab-case, `message` is nonempty, and the counters appear together with `0 <= completed <= total` and `total >= 1` (an empty collection reports no counters). In json and text formats progress renders as a stderr line (`progress[phase]: message (c/t)`) so stdout stays terminal-only. Every stream ends with exactly one terminal event (`summary`, `confirmation_required`, or `error`) — including an interrupted run, which ends with an `error` event of code `interrupted` (exit 130, `transient: true`; re-run a mutation without `--yes` or `--confirm` so it re-plans against the current state). Anything a handler prints through Effect's `Console` lands on stderr, never in the stream. Collections stream items individually; `--fields id,title` projects item fields against the command's static field inventory — unknown fields fail identically on empty and populated collections, with the available set in `fix`. Projection requires a machine format.

## Mutation flow

1. `mycli thing create X --json` → exit 4, plan + token envelope. Nothing changed.
2. Replay `confirmArgs` (same command + `--confirm <token>` + the machine format flag) → applies exactly the previewed plan. The token binds `{command, schemaVersion, plan}`.
3. Stale token (state changed since the preview) → `stale_confirmation`, exit 64. Re-plan.
4. One-shot: `--yes`. Preview only: `--dry-run` (never changes anything).

## Introspection

- `mycli describe --json` — the command inventory (params, capabilities, error codes, examples, guides), the global flags, the guide topics, the exit registry, and the error catalog; envelope and event shapes live in `schema --json`. `--help` in JSON mode returns the same payload for any known command path, regardless of the command flags or positionals after it; an unknown path, an unknown flag before the path, or an invalid value for a global flag (`--format`, `--log-level`, `--completions`) is still `invalid_usage`.
- `mycli schema --json` — JSON Schema (draft 2020-12) for every command's params, output, and plan.

- `mycli describe --command "<name>" --json` — one command's surface and only the guides it references, for a smaller context budget.
- `mycli guide list --json` / `mycli guide get <topic> [--brief] --json` — the version-matched guide catalog: knowledge the surface cannot express (see [GUIDANCE.md](GUIDANCE.md)).

All of them work with no auth, network, config, or state. They are the discovery path; help text is for humans.
