# 0002 — Self-contained CJS bundle

Status: accepted (2026-08)

## Context

Effect's minified ESM bundle breaks on a transitive dynamic `require` (undici via the platform HTTP client). Bundling is mandatory anyway: it cuts Effect's startup roughly 3.5× versus unbundled execution, and a published CLI should not impose its dependency tree on consumers.

## Decision

tsdown bundles `src/bin.ts` to a single `dist/bin.cjs` with `noExternal: /^(?!node:)/`. The published package has zero runtime dependencies; `effect` lives in devDependencies. The `bin/` launcher is a two-line `require`.

## Cost

Consumers cannot patch dependencies via their own resolution, and the artifact is ~1 MB. Revisit ESM output when the upstream dynamic-require issue is gone.
