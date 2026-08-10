#!/usr/bin/env node
// Rename the starter into your CLI. Usage: node scripts/rename.mjs <new-name>
// Rewrites the package name, bin entry, launcher, CLI identity, and env-var
// prefix, then renames the launcher file. Grep for the old name afterwards if
// you also want docs and examples updated (they reference the bin name).
import { readFileSync, renameSync, writeFileSync } from "node:fs"

const name = process.argv[2]
if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name)) {
  process.stderr.write("usage: node scripts/rename.mjs <kebab-case-name>\n")
  process.exit(64)
}

const envPrefix = name.replace(/-/g, "_").toUpperCase()

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const oldName = pkg.name
pkg.name = name
pkg.bin = { [name]: `./bin/${name}.cjs` }
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`)

const launcher = readFileSync("bin/lasso.cjs", "utf8")
writeFileSync("bin/lasso.cjs", launcher)
renameSync("bin/lasso.cjs", `bin/${name}.cjs`)

const meta = readFileSync("src/meta.ts", "utf8")
writeFileSync("src/meta.ts", meta.replace(`CLI_NAME = "${oldName}"`, `CLI_NAME = "${name}"`))

const format = readFileSync("src/output/format.ts", "utf8")
writeFileSync("src/output/format.ts", format.replaceAll("LASSO_FORMAT", `${envPrefix}_FORMAT`))

const smoke = readFileSync("scripts/pack-smoke.mjs", "utf8")
writeFileSync(
  "scripts/pack-smoke.mjs",
  smoke
    .replaceAll(`"${oldName}"`, `"${name}"`)
    .replaceAll(`".bin", "${oldName}"`, `".bin", "${name}"`),
)

process.stderr.write(`renamed ${oldName} → ${name}\n`)
process.stderr.write(`grep -ri ${oldName} to find remaining references in docs and tests\n`)
