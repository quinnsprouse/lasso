# Whole-app Effect on the v4 beta, exact-pinned

The v3 line is feature-frozen and ships no agent docs; v4 ships `AGENTS.md` and compile-checked examples inside the npm package, at the cost of `unstable/*` modules that may break in minors — so `effect` is pinned exactly and re-pins are deliberate maintenance events verified by the Push profile. Never use the v3 `@effect/cli` package (its source is deleted upstream); if the beta becomes untenable, the CommandContract adapter is the seam for a Stricli + Zod fallback.
