#!/usr/bin/env node
// Command generator: scaffolds a query contract and registers it in the
// roster. Usage: node scripts/new-command.mjs <group> <name>   (or just <name>)
// The result compiles and passes the Fast profile immediately; replace the
// handler body with real logic.
//
// Every check runs before the first write, and every write (module, roster
// entry, formatting, surface snapshot) is one transaction that rolls back on
// failure, so the generator never leaves the tree half-edited.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { assertWorkspace, requireToolchain, execTool, repoRoot } from "./lib/toolchain.mjs"

const [groupArg, nameArg] = process.argv.slice(2)
if (groupArg === undefined) {
  process.stderr.write("usage: node scripts/new-command.mjs <group> <name> | <name>\n")
  process.exit(64)
}
const parts = nameArg === undefined ? [groupArg] : [groupArg, nameArg]
if (!parts.every((part) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(part))) {
  process.stderr.write("names must be kebab-case: [a-z][a-z0-9]*(-[a-z0-9]+)*\n")
  process.exit(64)
}

// Every identifier that cannot (or should not) be an `export const` name in
// an ES module: reserved words, strict-mode reserved words, contextual
// keywords reserved in modules, and the restricted or footgun bindings.
const RESERVED = new Set(
  `await break case catch class const continue debugger default delete do else enum export
   extends false finally for function if import in instanceof new null return super switch
   this throw true try typeof var void while with yield implements interface let package
   private protected public static arguments eval undefined`.split(/\s+/),
)

const commandName = parts.join(" ")
const fileBase = parts.join("-")
const exportName = fileBase.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

assertWorkspace()
requireToolchain()
const file = join(repoRoot, "src", "commands", `${fileBase}.ts`)
const indexFile = join(repoRoot, "src", "commands", "index.ts")
const relFile = relative(repoRoot, file)
const relIndex = relative(repoRoot, indexFile)

if (RESERVED.has(exportName)) {
  process.stderr.write(`"${exportName}" is a reserved word — pick another name\n`)
  process.exit(64)
}
// The scaffold's summary must satisfy the invariant (≤ 88 characters) as generated.
const summary = `Describe what ${commandName} returns`
if (summary.length > 88) {
  process.stderr.write(
    `"${commandName}" is too long: the generated summary would exceed 88 characters\n`,
  )
  process.exit(64)
}
// A new path must not collide with the roster: an existing command, a leaf under
// an existing top-level command, or a group name that is already a command.
const roster = JSON.parse(
  execFileSync(process.execPath, [join(repoRoot, "src", "bin.ts"), "describe", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
).data.commands.map((command) => command.name)
const collides =
  roster.includes(commandName) ||
  (parts.length === 2 && roster.includes(parts[0])) ||
  (parts.length === 1 && roster.some((name) => name.startsWith(`${commandName} `)))
if (collides) {
  process.stderr.write(
    `"${commandName}" collides with an existing command or group in the roster\n`,
  )
  process.exit(73)
}
if (existsSync(file)) {
  process.stderr.write(`${relFile} already exists\n`)
  process.exit(73)
}

const binName = Object.keys(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).bin)[0]

const index = readFileSync(indexFile, "utf8")
for (const marker of ["// generator:imports", "  // generator:contracts"]) {
  if (!index.includes(marker)) {
    process.stderr.write(`marker "${marker.trim()}" missing from ${relIndex} — cannot register\n`)
    process.exit(78)
  }
}
// Registered means an import line or a roster entry — not a mention in a comment.
const registered = new RegExp(`^import \\{ ${exportName} \\}|^\\s+${exportName},$`, "m")
if (registered.test(index)) {
  process.stderr.write(`"${exportName}" is already registered in ${relIndex}\n`)
  process.exit(73)
}

const source = `import { Effect, Schema } from "effect"
import { defineQuery } from "../contract/contract.ts"

export const ${exportName} = defineQuery({
  name: "${commandName}",
  summary: "${summary}",
  stability: "experimental",
  params: {},
  dataSchema: Schema.Struct({ message: Schema.String }),
  domainErrorCodes: [],
  examples: [
    {
      command: "${binName} ${commandName} --json",
      description: "Run ${commandName} and print the JSON envelope",
    },
  ],
  // Use Effect.fn("${exportName}.handler")(function* () { … }) when the handler needs services.
  handler: () => Effect.succeed({ message: "implement me" }),
  renderText: (data) => data.message,
})
`

const updated = index
  .replace(
    "// generator:imports",
    `import { ${exportName} } from "./${fileBase}.ts"\n// generator:imports`,
  )
  .replace("  // generator:contracts", `  ${exportName},\n  // generator:contracts`)

// All checks passed. Every write below is one transaction: the new module,
// the roster entry, formatting, and the surface snapshot (a new command is an
// additive surface change). Any failure rolls every file back.
const snapshotFile = join(repoRoot, "test", "contract", "surface.snapshot.json")
const snapshotBefore = existsSync(snapshotFile) ? readFileSync(snapshotFile, "utf8") : undefined
let wroteFile = false
let wroteIndex = false
try {
  writeFileSync(file, source)
  wroteFile = true
  writeFileSync(indexFile, updated)
  wroteIndex = true
  execTool("biome", ["format", "--write", relFile, relIndex], { stdio: "pipe" })
  execFileSync(process.execPath, [join(repoRoot, "scripts", "surface-snapshot.mjs")], {
    cwd: repoRoot,
    stdio: "pipe",
  })
} catch (error) {
  if (wroteFile) rmSync(file, { force: true })
  if (wroteIndex) writeFileSync(indexFile, index)
  if (snapshotBefore !== undefined) writeFileSync(snapshotFile, snapshotBefore)
  process.stderr.write(
    `generation failed; rolled back ${relFile}, ${relIndex}, and the surface snapshot\n`,
  )
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}${error.message}\n`)
  process.exit(70)
}

process.stderr.write(
  `created ${relFile}, registered "${commandName}", and recorded it in the surface snapshot\n`,
)
process.stderr.write(`next: implement the handler, then run: npm run check\n`)
