import { defineConfig } from "tsdown"

export default defineConfig({
  entry: { bin: "src/bin.ts" },
  // CJS is deliberate: Effect's minified ESM bundle breaks on a transitive
  // dynamic require (undici via the platform HTTP client). See ADR 0002.
  format: "cjs",
  platform: "node",
  target: "node22",
  // Ship self-contained: the published package has zero runtime dependencies.
  noExternal: /^(?!node:)/,
  minify: false,
  dts: false,
  sourcemap: false,
  publint: true,
  attw: false,
  outDir: "dist",
})
