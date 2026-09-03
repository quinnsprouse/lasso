#!/usr/bin/env node
// Test hygiene: no suite may be skipped, focused, or left as a todo to get
// green. TESTING.md states the rule; this makes it fail the Fast profile.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { repoRoot } from "./lib/toolchain.mjs"

const PATTERN =
  /\b(?:it|test|describe|suite|bench)(?:\s*\.\s*\w+)*\s*\.\s*(?:skip|only|todo|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/g

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      walk(path)
    } else if (entry.endsWith(".test.ts")) {
      files.push(path)
    }
  }
}
walk(join(repoRoot, "test"))

const offenders = []
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n")
  lines.forEach((line, index) => {
    if (PATTERN.test(line)) {
      offenders.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`)
    }
    PATTERN.lastIndex = 0
  })
}

if (offenders.length > 0) {
  process.stderr.write("skipped or focused tests are not allowed:\n")
  for (const offender of offenders) {
    process.stderr.write(`  ${offender}\n`)
  }
  process.stderr.write("fix: make the test pass or delete it; never .skip/.only/.todo\n")
  process.exit(1)
}
process.stderr.write(`test hygiene ok (${files.length} files)\n`)
