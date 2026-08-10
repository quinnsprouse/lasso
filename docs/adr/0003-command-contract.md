# 0003 — CommandContract owns the surface; the parser is an adapter

Status: accepted (2026-08)

## Context

A CLI's surfaces drift: help text, JSON output, docs, and machine schemas each get edited separately. Agents consume all of them, and drift between surfaces is worse for an agent than a missing feature. The parser itself (`effect/unstable/cli`) may receive breaking changes in minor releases.

## Decision

Every command is a `defineQuery`/`defineMutation` contract. `src/contract/adapter.ts` is the only module that imports the parser (lint-enforced); `describe`, `schema`, help, and docs derive from the contract. Mutations structurally require `plan`/`apply`, so `--dry-run` and the exit-4 confirmation protocol exist for every mutation by construction. Contract invariants run as tests in the Fast profile.

## Cost

An abstraction layer over the parser (~300 lines) that a plain CLI would not carry, and contract params support a deliberate subset of the parser's features. Escape hatch: extend the adapter, never bypass it.
