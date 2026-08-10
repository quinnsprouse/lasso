import { defineConfig } from "tsdown"

export default defineConfig({
  entry: { bin: "src/bin.ts" },
  // CJS is deliberate: Effect's minified ESM bundle breaks on a transitive
  // dynamic require (undici via the platform HTTP client).
  format: "cjs",
  platform: "node",
  target: "node22",
  // Ship self-contained: the published package has zero runtime dependencies.
  // onlyBundle is an allowlist — an unexpected dependency in the bundle is a
  // build error, not a silent size increase.
  deps: {
    alwaysBundle: /^(?!node:)/,
    onlyBundle: ["effect", "@effect/platform-node", "@effect/platform-node-shared"],
  },
  minify: false,
  // effect's ConfigProvider probes import.meta?.env; under CJS it falls back
  // to process.env, so replacing import.meta with {} is the intended result.
  define: { "import.meta": "{}" },
  dts: false,
  sourcemap: false,
  // publint itself shells out to `npm pack`; when tsdown runs inside a pack
  // lifecycle (prepack), that recursion breaks — so prepack skips it. The
  // Push/CI builds run with publint on.
  publint: process.env["TSDOWN_SKIP_PUBLINT"] === undefined,
  attw: false,
  outDir: "dist",
})
