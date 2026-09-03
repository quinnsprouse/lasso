#!/usr/bin/env node
// SessionStart: surface workspace health before the first edit. Missing
// node_modules, absent git hooks, or an unpatched Effect lint install are
// reported now, with the fix, instead of as a confusing failure later.
// Never blocks: prints the doctor report to stdout (Claude sees it as context).
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const { repoRoot, workspaceFrom } = await import("../../scripts/lib/toolchain.mjs")

let input = {}
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  // no payload: still run the doctor against the project root
}
const root = workspaceFrom(input?.cwd) ?? repoRoot

let report
try {
  report = execFileSync(process.execPath, [join(root, "scripts", "doctor.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 20_000,
  })
} catch (error) {
  report = error.stdout ?? ""
}
try {
  const parsed = JSON.parse(report)
  const problems = parsed.checks.filter((check) => !check.ok)
  if (problems.length === 0) {
    process.stdout.write("lasso doctor: workspace healthy\n")
  } else {
    process.stdout.write("lasso doctor found problems — fix these before editing:\n")
    for (const problem of problems) {
      process.stdout.write(
        `  ✗ ${problem.name}: ${problem.detail}${problem.fix ? `\n    fix: ${problem.fix}` : ""}\n`,
      )
    }
  }
} catch {
  process.stdout.write("lasso doctor: could not run (is node_modules installed? run: npm ci)\n")
}
