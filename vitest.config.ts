import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    allowOnly: false,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/bin.ts"],
      // Recalibrate when replacing the demo, not to make a failing change pass.
      thresholds: {
        lines: 91,
        statements: 91,
        functions: 92,
        branches: 84,
      },
    },
  },
})
