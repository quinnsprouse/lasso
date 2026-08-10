#!/usr/bin/env node
// Rename the starter into your CLI. Usage: node scripts/rename.mjs <new-name>
// Rewrites every tracked reference — package identity, bin launcher, CLI
// metadata, env-var prefix, state directory, examples, docs, and tests — so
// the full verification suite stays green after the rename.
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const name = process.argv[2]
if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name)) {
  process.stderr.write("usage: node scripts/rename.mjs <kebab-case-name>\n")
  process.exit(64)
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const oldName = Object.keys(pkg.bin)[0]
if (oldName === name) {
  process.stderr.write(`already named ${name}\n`)
  process.exit(0)
}
const oldPrefix = oldName.replace(/-/g, "_").toUpperCase()
const newPrefix = name.replace(/-/g, "_").toUpperCase()

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", `.${oldName}`, ".lasso"])
const TEXT_EXT = /\.(ts|mjs|cjs|json|md|yml|yaml)$/

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        walk(path)
      }
    } else if (TEXT_EXT.test(entry) || entry === "LICENSE") {
      files.push(path)
    }
  }
}
walk(".")

let changed = 0
for (const file of files) {
  const before = readFileSync(file, "utf8")
  const after = before
    .replaceAll(new RegExp(`\\b${oldName}\\b`, "g"), name)
    .replaceAll(new RegExp(`\\b${oldPrefix}_`, "g"), `${newPrefix}_`)
  if (after !== before) {
    writeFileSync(file, after)
    changed += 1
  }
}

renameSync(`bin/${oldName}.cjs`, `bin/${name}.cjs`)

// The new name changes line lengths; re-format so the Fast profile stays green.
execFileSync("npx", ["biome", "format", "--write", "."], { stdio: "ignore" })

process.stderr.write(`renamed ${oldName} → ${name} across ${changed} files\n`)
process.stderr.write("next: npm run check, then update package.json repository if it changed\n")
