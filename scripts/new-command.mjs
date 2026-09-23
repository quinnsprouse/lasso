#!/usr/bin/env node
// Command generator: scaffolds a query (default) or a mutation (--mutation)
// contract and registers it in the roster. A mutation also gets its required
// plan fixture in test/fixtures/mutations.ts.
// Usage: node scripts/new-command.mjs <group> <name> [--mutation]   (or just <name>)
// The result compiles and passes the Fast profile immediately; replace the
// handler (or plan and apply) with real logic.
//
// The name checks run before the first write. Every write (module, roster
// entry, fixture, formatting, a typecheck, surface snapshot) is one
// transaction that rolls back on failure, so the generator never leaves the
// tree half-edited or red.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { assertWorkspace, requireToolchain, execTool, repoRoot } from "./lib/toolchain.mjs"

const USAGE =
  "usage: node scripts/new-command.mjs <group> <name> [--mutation] | <name> [--mutation]\n"
const argv = process.argv.slice(2)
const mutation = argv.includes("--mutation")
const positional = argv.filter((arg) => arg !== "--mutation")
const [groupArg, nameArg] = positional
if (groupArg === undefined || positional.length > 2 || positional.some((a) => a.startsWith("-"))) {
  process.stderr.write(USAGE)
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
const typeName = `${exportName[0].toUpperCase()}${exportName.slice(1)}`

assertWorkspace()
requireToolchain()
const file = join(repoRoot, "src", "commands", `${fileBase}.ts`)
const indexFile = join(repoRoot, "src", "commands", "index.ts")
const fixturesFile = join(repoRoot, "test", "fixtures", "mutations.ts")
const relFile = relative(repoRoot, file)
const relIndex = relative(repoRoot, indexFile)
const relFixtures = relative(repoRoot, fixturesFile)

if (RESERVED.has(exportName)) {
  process.stderr.write(`"${exportName}" is a reserved word — pick another name\n`)
  process.exit(64)
}
// The scaffold's summary must satisfy the invariant (≤ 88 characters) as generated.
const summary = mutation
  ? `Describe what ${commandName} changes`
  : `Describe what ${commandName} returns`
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

const requireMarkers = (text, markers, rel) => {
  for (const marker of markers) {
    if (!text.includes(marker)) {
      process.stderr.write(`marker "${marker.trim()}" missing from ${rel} — cannot register\n`)
      process.exit(78)
    }
  }
}

const index = readFileSync(indexFile, "utf8")
requireMarkers(index, ["// generator:imports", "  // generator:contracts"], relIndex)
const fixtures = mutation ? readFileSync(fixturesFile, "utf8") : undefined
if (fixtures !== undefined) {
  requireMarkers(fixtures, ["// generator:imports", "  // generator:fixtures"], relFixtures)
}
const querySource = `import { Effect, Schema } from "effect"
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

const mutationSource = `import { Effect, Schema } from "effect"
import { defineMutation } from "../contract/contract.ts"

// The plan is the whole intent: the runtime encodes it, hashes it into the
// confirmation token, and hands apply its decoded form. Keep it deterministic
// (no timestamps or random ids; assign those in apply) and self-contained.
const ${typeName}Plan = Schema.Struct({
  changes: Schema.Array(Schema.String),
})

export const ${exportName} = defineMutation({
  name: "${commandName}",
  summary: "${summary}",
  stability: "experimental",
  // Revisit: "always" means re-applying the same plan is safe.
  idempotency: { kind: "always" },
  params: {},
  planSchema: ${typeName}Plan,
  dataSchema: Schema.Struct({ applied: Schema.Int }),
  domainErrorCodes: [],
  examples: [
    {
      command: "${binName} ${commandName} --dry-run --json",
      description: "Preview the plan without changing anything",
    },
    {
      command: "${binName} ${commandName} --yes --json",
      description: "Apply in one non-interactive step",
    },
  ],
  // plan gets read services (PlanServices), apply gets write services
  // (ApplyServices). Use Effect.fn("${exportName}.plan")(function* (input) { … })
  // once either needs services, and update the fixture in ${relFixtures}.
  plan: () => Effect.succeed({ changes: [] }),
  apply: (plan) => Effect.succeed({ applied: plan.changes.length }),
  renderPlanText: (plan) => \`Will apply \${plan.changes.length} change(s)\`,
  renderText: (data) => \`Applied \${data.applied} change(s)\`,
})
`

const updatedIndex = index
  .replace(
    "// generator:imports",
    `import { ${exportName} } from "./${fileBase}.ts"\n// generator:imports`,
  )
  .replace("  // generator:contracts", `  ${exportName},\n  // generator:contracts`)

const updatedFixtures = fixtures
  ?.replace(
    "// generator:imports",
    `import { ${exportName} } from "../../src/commands/${fileBase}.ts"\n// generator:imports`,
  )
  .replace(
    "  // generator:fixtures",
    `  planFixture(${exportName}, {
    name: "${commandName} plans its changes",
    input: {},
    expected: { plan: { changes: [] } },
  }),
  // generator:fixtures`,
  )

// All checks passed. Every write below is one transaction: the new module,
// the roster entry, the fixture, formatting, a typecheck, and the surface
// snapshot (a new command is an additive surface change). Any failure restores
// every file. `before: undefined` means the file is new and is removed.
const edits = [
  { path: file, text: mutation ? mutationSource : querySource, before: undefined },
  { path: indexFile, text: updatedIndex, before: index },
  ...(fixtures !== undefined
    ? [{ path: fixturesFile, text: updatedFixtures, before: fixtures }]
    : []),
]
const edited = edits.map((edit) => relative(repoRoot, edit.path))
const snapshotFile = join(repoRoot, "test", "contract", "surface.snapshot.json")
const snapshotBefore = existsSync(snapshotFile) ? readFileSync(snapshotFile, "utf8") : undefined
// With a listener, Node delivers a signal only after this synchronous
// transaction has committed or rolled back; then the run exits 130.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    process.exitCode = 130
  })
}
const written = []
try {
  for (const edit of edits) {
    writeFileSync(edit.path, edit.text)
    written.push(edit)
  }
  execTool("biome", ["format", "--write", ...edited], { stdio: "pipe" })
  // The compiler, not a name scan, decides whether the new export collides
  // with a binding in any file the generator touched.
  execTool("tsc", ["--noEmit"], { stdio: "pipe" })
  execFileSync(process.execPath, [join(repoRoot, "scripts", "surface-snapshot.mjs")], {
    cwd: repoRoot,
    stdio: "pipe",
  })
} catch (error) {
  for (const edit of written) {
    if (edit.before === undefined) rmSync(edit.path, { force: true })
    else writeFileSync(edit.path, edit.before)
  }
  if (snapshotBefore !== undefined) writeFileSync(snapshotFile, snapshotBefore)
  process.stderr.write(
    `generation failed; rolled back ${edited.join(", ")}, and the surface snapshot\n`,
  )
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}${error.message}\n`)
  process.exit(70)
}

const created = mutation ? `${relFile} and its plan fixture` : relFile
process.stderr.write(
  `created ${created}, registered "${commandName}", and recorded it in the surface snapshot\n`,
)
process.stderr.write(
  mutation
    ? [
        "next: implement plan (read services) and apply (write services), then",
        `  1. update the fixture in ${relFixtures}; add cases for each plan branch and expected error`,
        "  2. add a unit test through fake layers (pattern: test/unit/task-create.test.ts)",
        "  3. add a happy-path and a failure e2e case in test/e2e/cli.test.ts",
        "  4. run: npm run surface:update && npm run check",
        "",
      ].join("\n")
    : "next: implement the handler, then run: npm run check\n",
)
