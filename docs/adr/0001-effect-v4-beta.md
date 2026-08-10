# 0001 — Whole-app Effect on the v4 beta, exact-pinned

Status: accepted (2026-08)

## Context

The kit's premise is guardrails that fail mechanically for agent-written code. Effect provides typed errors, Schema validation at every boundary, DI layers for testability, and a language service whose 50+ diagnostics run in CI. The v3 line is feature-frozen and ships no agent documentation; v4 ships `AGENTS.md` and compile-checked example docs inside the npm package, but its `unstable/*` modules may break in minor releases.

## Decision

Pin `effect` and `@effect/platform-node` to an exact v4 beta version. Use Effect for handlers, services, and the runtime; keep pure domain functions in plain TypeScript. Exactly one `Effect.run*` call exists, in `src/bin.ts`. Never use the v3 `@effect/cli` package — its source is already deleted upstream.

## Cost

Re-pins are deliberate maintenance events (test the whole Push profile after each). The bundle is ~1 MB / ~250 KB gzipped and startup pays ~50 ms. If the beta becomes untenable, the fallback is Stricli + Zod, and the CommandContract adapter is the seam that makes that swap contained.
