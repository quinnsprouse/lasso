#!/usr/bin/env node
// Rename the starter into your CLI. Usage: node scripts/rename.mjs <new-name>
// Rewrites every tracked reference — package identity, bin launcher, CLI
// metadata, env-var prefix, state directory (and its .gitignore entry),
// examples, docs, and tests — so the full verification suite stays green
// after the rename.
import { execFileSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { assertWorkspace, requireToolchain, execTool, repoRoot } from "./lib/toolchain.mjs"

const name = process.argv[2]
if (name === undefined || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
  process.stderr.write("usage: node scripts/rename.mjs <kebab-case-name>\n")
  process.exit(64)
}

assertWorkspace()
requireToolchain()

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
const oldName = Object.keys(pkg.bin)[0]
if (oldName === name) {
  process.stderr.write(`already named ${name}\n`)
  process.exit(0)
}
const titleCase = (value) => value.charAt(0).toUpperCase() + value.slice(1)
const oldPrefix = oldName.replace(/-/g, "_").toUpperCase()
const newPrefix = name.replace(/-/g, "_").toUpperCase()

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", `.${oldName}`, ".lasso"])
const TEXT_EXT = /\.(ts|mjs|cjs|json|md|yml|yaml)$/
// Extensionless files that still carry the name: the license header and the
// ignore list (which must ignore the renamed state directory).
const TEXT_NAMES = new Set(["LICENSE", ".gitignore", ".npmrc"])

// Candidates are what git sees: tracked files plus untracked files that are
// not ignored (a freshly generated command counts; node_modules, dist, and
// .scratch do not). Symlinks are never rewritten. Without a repository (degit
// before git init) fall back to a walk that never follows symlinks.
const tracked = () => {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => join(repoRoot, entry))
  } catch {
    return undefined
  }
}
const walk = (dir, into) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      continue
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        walk(path, into)
      }
    } else {
      into.push(path)
    }
  }
  return into
}
const files = (tracked() ?? walk(repoRoot, [])).filter((path) => {
  const base = path.slice(path.lastIndexOf("/") + 1)
  if (!TEXT_EXT.test(base) && !TEXT_NAMES.has(base)) {
    return false
  }
  // A tracked path can be gone from disk (the launcher moved by a previous rename).
  const stat = lstatSync(path, { throwIfNoEntry: false })
  return stat !== undefined && stat.isFile()
})

// The template's own coordinates, which the README keeps. Spelled in halves so
// the word rewrite below never reaches the constant.
const TEMPLATE = ["quinnsprouse", ["las", "so"].join("")].join("/")

// A name the project already uses as a word would be rewritten by any later
// rename away from it (`task` would take every `Task` class with it). The
// current name (`lasso` inside `lasso-renamed`) and the template coordinates
// are not uses.
const current = new RegExp(`\\b(${oldName}|${titleCase(oldName)}|${oldPrefix}_)`, "g")
const uses = [`\\b${name}\\b`, `\\b${titleCase(name)}\\b`, `\\b${newPrefix}_`].map(
  (pattern) => new RegExp(pattern),
)
const inUse = files.filter((file) => {
  const text = readFileSync(file, "utf8").replaceAll(TEMPLATE, "").replace(current, "")
  return uses.some((pattern) => pattern.test(text))
})
if (inUse.length > 0) {
  process.stderr.write(
    `"${name}" already appears as a word in ${inUse.length} file(s), e.g. ${inUse[0].slice(repoRoot.length + 1)}; pick a name the project does not use\n`,
  )
  process.exit(64)
}

let changed = 0
for (const file of files) {
  const before = readFileSync(file, "utf8")
  const after = before
    .replaceAll(new RegExp(`\\b${oldName}\\b`, "g"), name)
    .replaceAll(new RegExp(`\\b${titleCase(oldName)}\\b`, "g"), titleCase(name))
    .replaceAll(new RegExp(`\\b${oldPrefix}_`, "g"), `${newPrefix}_`)
  if (after !== before) {
    writeFileSync(file, after)
    changed += 1
  }
}

renameSync(join(repoRoot, "bin", `${oldName}.cjs`), join(repoRoot, "bin", `${name}.cjs`))
// The shipped skill lives at skills/<bin name>/SKILL.md and its `name` must
// match the directory, so the directory moves with the name.
if (existsSync(join(repoRoot, "skills", oldName))) {
  renameSync(join(repoRoot, "skills", oldName), join(repoRoot, "skills", name))
}

// Derived files are regenerated, never rewritten: the guide catalog embeds
// the topics as JSON strings, where a "\n" glues "n" to the next word and
// defeats the word-boundary rewrite above.
if (existsSync(join(repoRoot, "scripts", "guides.mjs"))) {
  execFileSync(process.execPath, [join(repoRoot, "scripts", "guides.mjs")], {
    cwd: repoRoot,
    stdio: "ignore",
  })
}

// The README's quick start names the TEMPLATE, not the new CLI: restore those
// coordinates, and drop the sentence that only applied before the rename.
const readmePath = join(repoRoot, "README.md")
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8")
    .replaceAll(`quinnsprouse/${name}`, TEMPLATE)
    .replace(/^Rename the package before publishing[^.]*\. /m, "")
  writeFileSync(readmePath, readme)
}

// The new name changes line lengths; re-format so the Fast profile stays green.
execTool("biome", ["format", "--write", "."], { stdio: "ignore" })

process.stderr.write(`renamed ${oldName} → ${name} across ${changed} files\n`)
process.stderr.write(
  [
    "next: npm run check, then make the identity yours:",
    "  package.json: name (your npm scope), description, keywords, repository, homepage, bugs",
    "  src/meta.ts: CLI_SUMMARY",
    "  LICENSE: the copyright holder",
    `  skills/${name}/SKILL.md and guides/topics/: the demo router rows and topics`,
    "",
  ].join("\n"),
)
