#!/usr/bin/env node
// The verification profiles. One definition; the pre-push hook and CI run
// the same commands, so local green means CI green.
//
//   fast  format check, lint, types, effect diagnostics, unit tests
//   push  fast + build, publint, knip, e2e against dist, pack smoke test
//   ci    push + coverage + starter contract
import { spawnSync } from "node:child_process"

const profiles = {
  fast: [
    ["fmt:check", "npx", "biome", "format", "."],
    ["lint", "npx", "oxlint", "--type-aware"],
    ["typecheck", "npx", "tsc", "--noEmit"],
    [
      "effect diagnostics",
      "npx",
      "effect-tsgo",
      "diagnostics",
      "--project",
      "tsconfig.json",
      "--strict",
    ],
    // e2e is deliberately excluded here: it depends on dist, which Push builds.
    ["unit tests", "npx", "vitest", "run", "--reporter=dot", "test/unit", "test/contract"],
  ],
  push: [
    ["build", "npx", "tsdown"],
    ["knip", "npx", "knip"],
    ["e2e", "npx", "vitest", "run", "--reporter=dot", "test/e2e"],
    ["pack smoke", "node", "scripts/pack-smoke.mjs"],
  ],
  ci: [
    ["coverage", "npx", "vitest", "run", "--coverage", "--reporter=dot"],
    ["starter contract", "node", "scripts/starter-contract.mjs"],
  ],
}

const profile = process.argv[2]
if (!(profile in profiles)) {
  process.stderr.write(`usage: verify.mjs <fast|push|ci>\n`)
  process.exit(64)
}

const steps =
  profile === "fast"
    ? profiles.fast
    : profile === "push"
      ? [...profiles.fast, ...profiles.push]
      : [...profiles.fast, ...profiles.push, ...profiles.ci]

const started = Date.now()
for (const [name, cmd, ...args] of steps) {
  const stepStart = Date.now()
  process.stderr.write(`▸ ${name}\n`)
  const result = spawnSync(cmd, args, { stdio: "inherit" })
  const seconds = ((Date.now() - stepStart) / 1000).toFixed(1)
  if (result.status !== 0) {
    process.stderr.write(`✗ ${name} failed after ${seconds}s\n`)
    process.exit(result.status ?? 1)
  }
  process.stderr.write(`✓ ${name} (${seconds}s)\n`)
}
process.stderr.write(
  `\n${profile} profile green in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
)
