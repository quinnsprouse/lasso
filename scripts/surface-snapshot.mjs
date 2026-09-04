#!/usr/bin/env node
// Record command and schema definitions. Compatibility is decided in review.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { assertWorkspace, requireToolchain, execTool, repoRoot } from "./lib/toolchain.mjs"

assertWorkspace()
requireToolchain()
const [
  { contracts },
  { describeCli, schemaDocument },
  { CLI_NAME, CLI_VERSION },
  { normalizeSurface },
] = await Promise.all([
  import("../src/commands/index.ts"),
  import("../src/contract/jsonschema.ts"),
  import("../src/meta.ts"),
  import("../test/contract/surface-snapshot.ts"),
])
const options = { binName: CLI_NAME, version: CLI_VERSION, contracts }
const current = normalizeSurface(describeCli(options), schemaDocument(options))
const target = join(repoRoot, "test", "contract", "surface.snapshot.json")
writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`)
execTool("biome", ["format", "--write", target], { stdio: "ignore" })
process.stderr.write("Snapshot updated. Review git diff -- test/contract/surface.snapshot.json\n")
