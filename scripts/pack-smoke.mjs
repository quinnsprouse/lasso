#!/usr/bin/env node
// Proves the packed npm artifact installs and runs in isolation: `npm pack`,
// install the tarball into a temp dir, invoke the binary by name, and check
// the JSON protocol from a consumer's point of view.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertWorkspace } from "./lib/toolchain.mjs"

const root = assertWorkspace()
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const binName = Object.keys(pkg.bin)[0]
const work = mkdtempSync(join(tmpdir(), `${binName}-pack-`))
let tarball

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", ...options })

try {
  const packed = run("npm", ["pack", "--json"], { cwd: root })
  tarball = join(root, JSON.parse(packed)[0].filename)
  run("npm", ["init", "-y"], { cwd: work, stdio: "ignore" })
  run("npm", ["install", "--no-fund", "--no-audit", tarball], { cwd: work, stdio: "ignore" })

  // POSIX invokes the .bin shim by name, as a consumer would. Windows has no
  // extensionless shim, so it runs the installed launcher through node.
  const shim = join(work, "node_modules", ".bin", binName)
  const launcher = join(work, "node_modules", pkg.name, pkg.bin[binName])
  const invoke = (args, options = {}) =>
    process.platform === "win32"
      ? run(process.execPath, [launcher, ...args], { cwd: work, ...options })
      : run(shim, args, { cwd: work, ...options })

  const describe = invoke(["describe", "--json"])
  const parsed = JSON.parse(describe)
  if (parsed.status !== "ok" || parsed.data.cli.name !== binName) {
    throw new Error(`describe returned unexpected payload: ${describe.slice(0, 200)}`)
  }

  let confirmExit = 0
  try {
    invoke(["task", "create", "pack smoke", "--json"])
  } catch (error) {
    confirmExit = error.status
  }
  if (confirmExit !== 4) {
    throw new Error(`unconfirmed mutation should exit 4, got ${confirmExit}`)
  }

  process.stderr.write("pack smoke ok\n")
} finally {
  // Clean up on every path: a failed assertion must not leave a tarball in the repo.
  if (tarball !== undefined) {
    rmSync(tarball, { force: true })
  }
  rmSync(work, { recursive: true, force: true })
}
