# Output protocol

The machine surface is the default surface. stdout carries data; stderr carries diagnostics; the two never mix. Format negotiation happens before parsing: explicit `--format`/`--json` > `LASSO_FORMAT` env > auto (JSON when stdout is not a TTY, text on a terminal). `NO_COLOR`, `TERM=dumb`, and `CI` disable color; non-TTY stdin or `--no-input` means no prompt may ever block.

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

In JSON mode, expected errors also go to **stdout** (one parseable stream); the exit code still reports failure. `confirmArgs` is the canonical continuation — replay it verbatim; `confirmCommand` is display-only.

## Exit codes

0 success · 4 confirmation required · 64 usage · 65 invalid data · 69 service unavailable · 70 internal defect · 73 cannot write/conflict · 75 transient (retry may work) · 77 auth · 78 config · 130 interrupted.

The one distinction to branch on hardest: 75 and `"transient": true` mean retry; everything else means change something first.

## NDJSON (`--format ndjson`)

One event object per line: `item`, `warning`, `progress`, `summary`, `error`. Every stream ends with `summary` or `error`. Collections stream items individually; `--fields id,title` projects item fields (unknown fields fail with the available set in `fix`).

## Mutation flow

1. `mycli thing create X --json` → exit 4, plan + token envelope. Nothing changed.
2. Replay `confirmArgs` (same command + `--confirm <token>`) → applies exactly the previewed plan.
3. Stale token (state changed since the preview) → `stale_confirmation`, exit 64. Re-plan.
4. One-shot: `--yes`. Preview only: `--dry-run` (never changes anything).

## Introspection

- `mycli describe --json` — full command inventory: params, capabilities, error codes, examples, exit registry, envelope shapes. `--help` in JSON mode returns the same payload.
- `mycli schema --json` — JSON Schema (draft 2020-12) for every command's params, output, and plan.

Both work with no auth, network, config, or state. They are the discovery path; help text is for humans.
