#!/usr/bin/env node
// Command generator: scaffolds a query contract and registers it in the
// roster. Usage: node scripts/new-command.mjs <group> <name>   (or just <name>)
// The result compiles and passes the Fast profile immediately; replace the
// handler body with real logic.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [groupArg, nameArg] = process.argv.slice(2)
if (groupArg === undefined) {
  process.stderr.write("usage: node scripts/new-command.mjs <group> <name> | <name>\n")
  process.exit(64)
}
const parts = nameArg === undefined ? [groupArg] : [groupArg, nameArg]
if (!parts.every((part) => /^[a-z][a-z0-9-]*$/.test(part))) {
  process.stderr.write("names must be kebab-case: [a-z][a-z0-9-]*\n")
  process.exit(64)
}

const RESERVED = new Set([
  "class",
  "const",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "for",
  "function",
  "if",
  "import",
  "in",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
])

const commandName = parts.join(" ")
const fileBase = parts.join("-")
const exportName = fileBase.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
const file = join("src", "commands", `${fileBase}.ts`)

if (RESERVED.has(exportName)) {
  process.stderr.write(`"${exportName}" is a reserved word — pick another name\n`)
  process.exit(64)
}
if (existsSync(file)) {
  process.stderr.write(`${file} already exists\n`)
  process.exit(73)
}

const binName = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).bin)[0]

const indexFile = join("src", "commands", "index.ts")
const index = readFileSync(indexFile, "utf8")
for (const marker of ["// generator:imports", "  // generator:contracts"]) {
  if (!index.includes(marker)) {
    process.stderr.write(`marker "${marker.trim()}" missing from ${indexFile} — cannot register\n`)
    process.exit(78)
  }
}
if (index.includes(`{ ${exportName} }`) || new RegExp(`\\b${exportName},`).test(index)) {
  process.stderr.write(`"${exportName}" is already registered in ${indexFile}\n`)
  process.exit(73)
}

writeFileSync(
  file,
  `import { Effect, Schema } from "effect"
import { defineQuery } from "../contract/contract.ts"

export const ${exportName} = defineQuery({
  name: "${commandName}",
  summary: "Describe what ${commandName} returns",
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
  handler: () => Effect.succeed({ message: "implement me" }),
  renderText: (data) => data.message,
})
`,
)

const updated = index
  .replace(
    "// generator:imports",
    `import { ${exportName} } from "./${fileBase}.ts"\n// generator:imports`,
  )
  .replace("  // generator:contracts", `  ${exportName},\n  // generator:contracts`)
writeFileSync(indexFile, updated)

execFileSync("npx", ["biome", "format", "--write", file, indexFile], { stdio: "ignore" })

process.stderr.write(`created ${file} and registered "${commandName}"\n`)
process.stderr.write(`next: implement the handler, then run: npm run check\n`)
