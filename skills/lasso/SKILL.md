---
name: lasso
description: Operate the lasso CLI safely through its machine-readable protocol - JSON envelopes, confirmation replay, next actions, and version-matched guides. Use when an agent needs to inspect or change data with the installed lasso binary.
license: MIT
compatibility: Requires the version-matched lasso CLI on PATH.
---

# lasso

`lasso <command> --json` inspects or changes data. This file is the safety contract and a router into the binary's own guides; it never restates command syntax. Discover syntax with `lasso describe --json` (one command: `lasso describe --command "task create" --json`).

## Operating contract

- Always pass `--json` (or `--format ndjson` for collections). stdout carries exactly one envelope; stderr carries diagnostics. Never parse prose.
- Every terminal envelope has `next` (executable moves: `args` is argv for `lasso`, run it verbatim) and `guides` (topic ids). Follow `next` before inventing a command. Fetch a guide with `lasso guide get <topic> --json` once per session when it is unfamiliar; `--brief` returns only its synopsis.
- Errors: `error.fix` is the recovery; `error.code` is what to branch on. `transient: true` (exits 69, 75, 130) means a retry may work; anything else means change something first. Never retry a non-transient error unchanged.
- Mutations preview first: exit 4 returns a plan and `confirmation.confirmArgs`; replay those args verbatim to apply exactly that plan. `stale_confirmation` (exit 64) means plan-relevant state changed: re-run without `--confirm` and read the new plan. Use `--yes` only when any plan the current state yields is acceptable. `--dry-run` never changes anything.
- Exit codes: 0 ok, 4 confirmation required, 64 usage, 65 invalid data, 69 service unavailable, 70 internal defect, 73 conflict or cannot write, 75 transient, 77 auth, 78 config, 130 interrupted.

## Intent router

When a row names a guide topic, fetch it before that flow's first command, once per session.

| Intent | First move | Guide topic |
|---|---|---|
| Orient: what can this CLI do | `lasso describe --json` | — |
| Read or filter tasks | `lasso task list --status all --json` | `task-ids` |
| Create a task, predict or reference its id | `lasso task create "<title>" --dry-run --json` | `task-ids` |
| Automate a mutation beyond one `--yes` | preview, then replay `confirmArgs` | `mutation-replay` |
| A create conflicts with existing state | follow `next` | `task-ids`, `mutation-replay` |
| Check the store for duplicates | `lasso task audit --format ndjson` | — |
| Find a guide for anything else | `lasso guide list --json` | — |

Never run topic names as commands.
