import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
const repoRoot = join(import.meta.dirname, "..", "..")

it("rejects forbidden runtime access, including aliases, while accepting composed effects", () => {
  // The type-aware rules only inspect files included by tsconfig, so fixtures live in src briefly.
  const dir = mkdtempSync(join(repoRoot, "src", "__lint_fixture_"))
  const cases = [
    {
      name: "direct",
      source:
        'import { Effect } from "effect"\nexport const value = Effect.runSync(Effect.succeed(1))',
      rule: "no-restricted-properties",
    },
    {
      name: "alias",
      source:
        'import { Effect as Fx } from "effect"\nexport const value = Fx.runSync(Fx.succeed(1))',
      rule: "no-restricted-properties",
    },
    {
      name: "destructure",
      source:
        'import { Effect as Fx } from "effect"\nconst { runSync } = Fx\nexport const value = runSync(Fx.succeed(1))',
      rule: "no-restricted-properties",
    },
    {
      name: "global",
      source: "export const stop = () => globalThis.process.exit(0)",
      rule: "no-restricted-properties",
    },
    {
      name: "process",
      source: "export const stop = () => process.exit(0)",
      rule: "no-restricted-globals",
    },
    {
      name: "parser",
      source:
        'import { Command } from "effect/unstable/cli"\nexport const command = Command.make("probe")',
      rule: "no-restricted-imports",
    },
    {
      name: "console",
      source: 'import { Console as Output } from "effect"\nexport const log = Output.log("probe")',
      rule: "no-restricted-imports",
    },
    {
      name: "valid",
      source: 'import { Effect as Fx } from "effect"\nexport const value = Fx.succeed(1)',
      rule: undefined,
    },
  ]
  try {
    const files = cases.map(({ name, source }) => {
      const file = join(dir, `${name}.ts`)
      writeFileSync(file, source)
      return file
    })
    const node = process.execPath
    const entry = join(repoRoot, "node_modules", "oxlint", "bin", "oxlint")
    const result = spawnSync(
      node,
      [entry, "--type-aware", "--deny-warnings", "--format", "json", ...files],
      { cwd: repoRoot, encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(1)
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{ filename: string; code: string }>
    }
    for (const fixture of cases) {
      const diagnostics = report.diagnostics.filter((diagnostic) =>
        diagnostic.filename.endsWith(`/${fixture.name}.ts`),
      )
      if (fixture.rule === undefined) expect(diagnostics).toEqual([])
      else
        expect(
          diagnostics.some((diagnostic) => diagnostic.code.includes(fixture.rule)),
          fixture.name,
        ).toBe(true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it("every lint suppression states its reason after --", () => {
  // Suppressing to get green is the easiest way around a rule; a stated reason
  // makes every exception reviewable. @ts-expect-error descriptions are
  // enforced by typescript/ban-ts-comment, biome-ignore by Biome's own syntax.
  const directive = /\/[/*]\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b(.*)$/
  const files = ["src", "scripts", "test", ".claude/hooks", "bin"].flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|mjs|cjs)$/.test(file))
      .map((file) => join(dir, file)),
  )
  const unexplained = files.flatMap((file) =>
    readFileSync(join(repoRoot, file), "utf8")
      .split("\n")
      .flatMap((line, index) => {
        const match = directive.exec(line)
        return match !== null && !/\s--\s+\S.{2,}/.test(match[1]!) ? [`${file}:${index + 1}`] : []
      }),
  )
  expect(unexplained, "add `-- <reason>` after each directive, or fix the code").toEqual([])
})
