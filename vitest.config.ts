import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/bin.ts"],
      // Ratchet policy: these sit just below what the suite currently
      // achieves. Raise them as coverage grows; recalibrate only when the
      // suite's composition changes (e.g. moving tests between profiles),
      // never to make a failing change pass.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 85,
        branches: 82,
      },
    },
  },
})
