import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/bin.ts"],
      // Set just below what the suite achieves so drops fail, and raise them
      // as coverage grows — never lower them to make a change pass.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 85,
        branches: 82,
      },
    },
  },
})
