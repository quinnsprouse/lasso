#!/usr/bin/env node
// Proves the packed npm artifact installs and runs in isolation: `npm pack`,
// install the tarball into a temp dir, invoke the binary by name, and check
// the JSON protocol from a consumer's point of view.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), "lasso-pack-"))

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", ...options })

try {
  const tarball = run("npm", ["pack", "--json"], { cwd: root })
  const filename = JSON.parse(tarball)[0].filename
  run("npm", ["init", "-y"], { cwd: work, stdio: "ignore" })
  run("npm", ["install", "--no-fund", "--no-audit", join(root, filename)], {
    cwd: work,
    stdio: "ignore",
  })

  const binary = join(work, "node_modules", ".bin", "lasso")

  const describe = run(binary, ["describe", "--json"], { cwd: work })
  const parsed = JSON.parse(describe)
  if (parsed.status !== "ok" || parsed.data.cli.name !== "lasso") {
    throw new Error(`describe returned unexpected payload: ${describe.slice(0, 200)}`)
  }

  let confirmExit = 0
  try {
    run(binary, ["task", "create", "pack smoke", "--json"], { cwd: work })
  } catch (error) {
    confirmExit = error.status
  }
  if (confirmExit !== 4) {
    throw new Error(`unconfirmed mutation should exit 4, got ${confirmExit}`)
  }

  rmSync(join(root, filename), { force: true })
  process.stderr.write("pack smoke ok\n")
} finally {
  rmSync(work, { recursive: true, force: true })
}
