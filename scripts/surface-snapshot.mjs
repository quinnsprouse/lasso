#!/usr/bin/env node
// The compatibility snapshot of the public surface: everything `describe`
// and `schema` advertise except the version. test/contract/compatibility.test.ts
// fails when anything recorded here is removed or changed (breaking) and
// when the surface gained something not yet recorded (additive, must be
// reviewed). This updater uses the SAME comparator and refuses to overwrite
// the snapshot while a breaking change is present, so the historical baseline
// cannot be erased by running the updater.
//
// Usage: npm run surface:update                     (records additions)
//        npm run surface:update -- --allow-breaking   (reviewed override: a change the
//                                           structural comparator cannot prove safe, or a
//                                           deliberate break — which also bumps schemaVersion)
// Node 22.18+ strips TypeScript types by default, so this script imports the
// TypeScript sources directly.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assertWorkspace, requireToolchain, execTool, repoRoot } from "./lib/toolchain.mjs"

const allowBreaking = process.argv.includes("--allow-breaking")
assertWorkspace()
requireToolchain()

const [{ contracts }, { describeCli, schemaDocument }, { CLI_NAME, CLI_VERSION }, diff] =
  await Promise.all([
    import("../src/commands/index.ts"),
    import("../src/contract/jsonschema.ts"),
    import("../src/meta.ts"),
    import("../test/contract/surface-diff.ts"),
  ])

const options = { binName: CLI_NAME, version: CLI_VERSION, contracts }
const current = diff.normalizeSurface(describeCli(options), schemaDocument(options))

const target = join(repoRoot, "test", "contract", "surface.snapshot.json")
if (existsSync(target)) {
  const recorded = JSON.parse(readFileSync(target, "utf8"))
  const drift = diff.diffSurface(recorded, current)
  if (drift.breaking.length > 0 && !allowBreaking) {
    process.stderr.write("refusing to record a BREAKING surface change:\n")
    for (const line of drift.breaking) {
      process.stderr.write(`  ${line}\n`)
    }
    process.stderr.write(
      "fix: restore the removed or changed surface (add, never rename or remove); after human review pass --allow-breaking, and bump schemaVersion for a genuine break\n",
    )
    process.exit(1)
  }
  if (drift.breaking.length === 0 && drift.additions.length === 0) {
    process.stderr.write("surface snapshot already current\n")
    process.exit(0)
  }
  for (const line of drift.additions) {
    process.stderr.write(`recorded addition: ${line}\n`)
  }
  for (const line of drift.breaking) {
    process.stderr.write(`recorded BREAKING change: ${line}\n`)
  }
}

writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`)
// The snapshot is a tracked file: keep it in the repository's format so the
// Fast profile's format check never trips on generated output.
execTool("biome", ["format", "--write", target], { stdio: "ignore" })
process.stderr.write(`wrote ${target}\n`)
