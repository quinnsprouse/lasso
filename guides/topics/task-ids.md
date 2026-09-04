---
topic: task-ids
title: How task ids are derived
brief: A task id is derived from its title, not assigned by the store. Read this before creating tasks whose ids you need to predict, reference, or de-duplicate.
---

# How task ids are derived

The store never assigns ids. `task create` derives the id from the title, so you can predict it before the write and reference it afterwards without a lookup.

The derivation, in order:

1. Lowercase the title.
2. Replace every run of characters outside `a-z0-9` with one `-`.
3. Trim leading and trailing `-`.
4. Keep the first 40 characters.
5. Prefix with `task_`.

Examples:

| Title | Id |
|---|---|
| `Ship the kit` | `task_ship-the-kit` |
| `  Ship: the KIT!  ` | `task_ship-the-kit` |
| `Ünïcode títle` | `task_n-code-t-tle` |

Consequences an agent should plan around:

- Two titles that differ only in case, punctuation, or whitespace collide. The second `task create` fails with `resource_conflict`; pass `--if-not-exists` to make it a no-op instead.
- Titles longer than 40 significant characters are truncated, so distinct long titles can share an id. Keep the distinguishing part of a title inside its first 40 characters.
- Non-ASCII letters are dropped, not transliterated. A title made only of such characters produces `task_`, which `task create` rejects at plan time as `invalid_data`.

To see the id the store will use, preview without writing:

```
lasso task create "Ship the kit" --dry-run --json
```

The plan's `task.id` (or `taskId` on a `no_op` plan) is the exact id that `--yes` or a confirmed replay will persist.
