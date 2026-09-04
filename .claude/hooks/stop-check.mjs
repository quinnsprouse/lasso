#!/usr/bin/env node
// Stop: do not end the turn while the repository is red. When the working
// tree has changes, runs the Fast profile (`npm run check`); on failure,
// exit 2 hands the failing step's output back to the agent to fix first.
// `stop_hook_active` guards against looping when the agent is already
// responding to this hook.
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const { repoRoot, workspaceFrom } = await import("../../scripts/lib/toolchain.mjs")

let input = {}
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  process.exit(0)
}
if (input?.stop_hook_active === true) {
  process.exit(0)
}
const root = workspaceFrom(input?.cwd) ?? repoRoot

let dirty = ""
try {
  dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
} catch {
  process.exit(0)
}
if (dirty.trim().length === 0) {
  process.exit(0)
}

const result = spawnSync(process.execPath, [join(root, "scripts", "verify.mjs"), "fast"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 110_000,
})
if (result.status === 0) {
  process.exit(0)
}
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
process.stderr.write(
  `npm run check is red with your changes; fix this before finishing:\n${output.slice(-4000)}\n`,
)
process.exit(2)
