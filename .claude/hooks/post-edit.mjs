#!/usr/bin/env node
// Edit Feedback: after every agent edit, format the touched file and return
// type/diagnostic errors while the agent still has context to repair them.
// Non-blocking on infrastructure failure; blocking (exit 2) on real errors.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

let input = ""
try {
  input = readFileSync(0, "utf8")
} catch {
  process.exit(0)
}

let filePath
try {
  filePath = JSON.parse(input).tool_input?.file_path
} catch {
  process.exit(0)
}
if (typeof filePath !== "string" || !/\.(ts|mjs|json)$/.test(filePath)) {
  process.exit(0)
}

try {
  execFileSync("npx", ["biome", "format", "--write", filePath], { stdio: "ignore", timeout: 30000 })
} catch {
  // formatting is best-effort; never block an edit on it
}

if (!filePath.endsWith(".ts")) {
  process.exit(0)
}

try {
  execFileSync("npx", ["tsc", "--noEmit"], { encoding: "utf8", timeout: 90000 })
} catch (error) {
  if (error.stdout) {
    process.stderr.write(String(error.stdout).slice(0, 4000))
    process.exit(2)
  }
}
