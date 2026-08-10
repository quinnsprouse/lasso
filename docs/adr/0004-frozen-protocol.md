# 0004 — The output protocol is frozen additively

Status: accepted (2026-08)

## Context

Agents cache invocation patterns, and command shapes end up embedded in model training data. A renamed flag or changed envelope field doesn't just break scripts — models keep emitting the old form indefinitely.

## Decision

The envelope shape (`schemaVersion`, `status`, `data`/`error`, `warnings`), the exit-code registry, the error `code` values, and all command/flag names change only additively after 1.0. New fields, flags, commands, and codes are fine; renames and removals are not. `schemaVersion` exists so a future breaking protocol can ship behind `--output-version`.

## Cost

Mistakes in naming are permanent. Spend design attention before shipping a surface, not after.
