#!/usr/bin/env node
// Release preparation: bumps every version source together, proves the
// compiled binary agrees, and prints the exact commands to finish. The
// release workflow REJECTS disagreement; this script is how you produce
// agreement. Usage: npm run release:prepare -- <patch|minor|major|x.y.z>
// (--quick skips the Push profile for CI contexts that already ran it.)
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { assertWorkspace, requireToolchain, execTool, repoRoot } from "./lib/toolchain.mjs"

const quick = process.argv.includes("--quick")
const bump = process.argv.slice(2).find((arg) => arg !== "--quick")
if (bump === undefined || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  process.stderr.write("usage: npm run release:prepare -- <patch|minor|major|x.y.z> [--quick]\n")
  process.exit(64)
}

// Everything below mutates the tree, so the target is verified first and every
// command runs in the repository root, never in whatever cwd invoked us.
assertWorkspace()
requireToolchain()
process.chdir(repoRoot)

const run = (cmd, cmdArgs, options = {}) =>
  execFileSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    cwd: repoRoot,
    ...options,
  })

if (run("git", ["status", "--porcelain"]).trim() !== "") {
  process.stderr.write("the worktree must be clean before preparing a release\n")
  process.exit(1)
}

run("npm", ["version", bump, "--no-git-tag-version"])
const version = JSON.parse(readFileSync("package.json", "utf8")).version

const meta = readFileSync("src/meta.ts", "utf8")
writeFileSync("src/meta.ts", meta.replace(/CLI_VERSION = "[^"]+"/, `CLI_VERSION = "${version}"`))

// Agreement across every version source, same rule the release workflow enforces.
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"))
const cliVersion = readFileSync("src/meta.ts", "utf8").match(/CLI_VERSION = "([^"]+)"/)[1]
if (lock.version !== version || cliVersion !== version) {
  process.stderr.write(
    `version sources disagree after bump: ${version} / ${lock.version} / ${cliVersion}\n`,
  )
  process.exit(1)
}

execTool("tsdown", ["--logLevel", "silent"], { stdio: ["ignore", "pipe", "inherit"] })
const reported = JSON.parse(run("node", ["dist/bin.cjs", "--version", "--json"])).data.version
if (reported !== version) {
  process.stderr.write(`the compiled binary reports ${reported}, expected ${version}\n`)
  process.exit(1)
}

if (!quick) {
  execFileSync("npm", ["run", "check:push"], { stdio: "inherit" })
}

process.stderr.write(`\nrelease ${version} prepared. To publish:\n\n`)
process.stderr.write(`  git add -A && git commit -m "chore: release v${version}"\n`)
process.stderr.write(`  git tag v${version}\n`)
process.stderr.write(`  git push && git push origin v${version}\n\n`)
process.stderr.write("the tag push triggers .github/workflows/release.yml (attest, then publish)\n")
