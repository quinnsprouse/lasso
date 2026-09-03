---
topic: mutation-replay
title: Confirmation tokens, replay, and idempotent writes
brief: What a confirmation token binds, why a replay can come back stale, and how --if-not-exists turns a conflict into a no-op. Read this before automating any mutation beyond a single --yes.
---

# Confirmation tokens, replay, and idempotent writes

Every mutation runs in two halves. `plan` reads state and derives a self-contained plan; `apply` executes exactly one confirmed plan and never sees your original input. The token in a `confirmation_required` envelope is a hash of `{command, schemaVersion, plan}`, so it stands for one plan against one observed state.

## Replay

Replay `confirmArgs` verbatim: it is the original argv plus `--confirm <token>` and the machine format flag. The runtime re-runs `plan`, re-hashes, and compares.

- Same state → same plan → same token → `apply` runs. Exit 0.
- Plan-relevant state changed since the preview (someone created that task) → the plan differs, or cannot be produced at all (a plain create now conflicts) → `stale_confirmation`, exit 64, with the underlying code in `details`. Nothing was written. Re-run without `--confirm` to get a fresh preview. Unrelated changes (another task was added) leave the plan, and so the token, intact.
- The token cannot be reused for another command or after a `schemaVersion` bump; those are different hashes by construction.

`--yes` skips the preview and applies whatever `plan` produces now. Use it only when you would accept any plan the current state yields.

## Idempotent writes

`task create` conflicts when the derived id already exists. With `--if-not-exists`, the conflict becomes a plan variant, `{ "action": "no_op", "reason": "already_exists", "taskId": "task_…" }`, that applies as a successful no-op: `created: false`, the existing task in `task`, and no write to the store file.

The token binds the plan, not the flags. When the task does not exist yet, `--if-not-exists` changes nothing about the plan, so a preview taken without it confirms with it added; when the task exists, the plan becomes the `no_op` variant and the token differs.

## What an interrupted run means

An interrupted mutation ends with `interrupted` (exit 130, `transient: true`). Re-run without `--yes` or `--confirm`: the fresh `plan` observes whatever the interrupted run left behind, and the preview shows you whether anything was written.

## A safe automation loop

```
lasso task create "Ship the kit" --json
lasso task create "Ship the kit" --confirm <token> --json
lasso task create "Ship the kit" --if-not-exists --yes --json
```

Preview, then replay the returned `confirmArgs`; when the agent may run the same step twice, prefer the idempotent form.
