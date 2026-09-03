#!/usr/bin/env node
// The verification profiles. One definition; the pre-push hook and CI run
// the same commands, so local green means CI green.
//
//   fast  format check, lint, types, effect diagnostics, test hygiene, guide catalog, unit + contract tests
//   push  fast + build (tsdown, with publint), knip, e2e against dist, pack smoke test
//   ci    push + coverage + starter contract
//
// Tools run through scripts/lib/toolchain.mjs: the pinned node_modules
// version, never npx (which would fetch a same-named package when the
// install is missing).
import { spawnSync } from "node:child_process"
import { repoRoot, requireToolchain, spawnTool } from "./lib/toolchain.mjs"

const step = (name, cmd, args) => ({ name, cmd, args })
const profiles = {
  fast: [
    step("fmt:check", "biome", ["format", "."]),
    step("lint", "oxlint", ["--type-aware", "--deny-warnings"]),
    step("typecheck", "tsc", ["--noEmit"]),
    step("effect diagnostics", "effect-tsgo", [
      "diagnostics",
      "--project",
      "tsconfig.json",
      "--strict",
    ]),
    step("test hygiene", "node", ["scripts/test-hygiene.mjs"]),
    step("guide catalog", "node", ["scripts/guides.mjs", "--check"]),
    // e2e is deliberately excluded here: it depends on dist, which Push builds.
    step("unit tests", "vitest", ["run", "--reporter=dot", "test/unit", "test/contract"]),
  ],
  push: [
    step("build", "tsdown", []),
    step("knip", "knip", []),
    step("e2e", "vitest", ["run", "--reporter=dot", "test/e2e"]),
    step("pack smoke", "node", ["scripts/pack-smoke.mjs"]),
  ],
  ci: [
    step("coverage", "vitest", ["run", "--coverage", "--reporter=dot"]),
    step("starter contract", "node", ["scripts/starter-contract.mjs"]),
  ],
}

const profile = process.argv[2]
if (!(profile in profiles)) {
  process.stderr.write(`usage: verify.mjs <fast|push|ci>\n`)
  process.exit(64)
}

requireToolchain()

const steps =
  profile === "fast"
    ? profiles.fast
    : profile === "push"
      ? [...profiles.fast, ...profiles.push]
      : [...profiles.fast, ...profiles.push, ...profiles.ci]

const started = Date.now()
for (const { name, cmd, args } of steps) {
  const stepStart = Date.now()
  process.stderr.write(`▸ ${name}\n`)
  const result =
    cmd === "node"
      ? spawnSync(process.execPath, args, { stdio: "inherit", cwd: repoRoot })
      : spawnTool(cmd, args)
  const seconds = ((Date.now() - stepStart) / 1000).toFixed(1)
  if (result.error !== undefined) {
    process.stderr.write(`✗ ${name} could not start: ${result.error.message}\n`)
    process.exit(78)
  }
  if (result.status !== 0) {
    process.stderr.write(`✗ ${name} failed after ${seconds}s\n`)
    process.exit(result.status ?? 1)
  }
  process.stderr.write(`✓ ${name} (${seconds}s)\n`)
}
process.stderr.write(
  `\n${profile} profile green in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
)
