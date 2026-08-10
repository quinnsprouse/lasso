# Self-contained CJS bundle

tsdown bundles everything into one `dist/bin.cjs` (~1 MB) with zero runtime dependencies, because Effect's minified ESM bundle breaks on a transitive dynamic `require` and bundling cuts startup ~3.5×. Revisit ESM output when the upstream dynamic-require issue is gone.
