#!/usr/bin/env node
// The Starter Contract: proves a fresh copy of this template gives a new
// repository every guarantee the kit advertises. Runs from `git archive HEAD`
// in a temp directory so untracked local files cannot make it pass.
//
// Failures preserve the temp directory and print its path as evidence.
import { execFileSync, execSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), "lasso-contract-"))
let failed = false

const step = (name, fn) => {
  if (failed) return
  process.stderr.write(`▸ ${name}\n`)
  try {
    fn()
    process.stderr.write(`✓ ${name}\n`)
  } catch (error) {
    failed = true
    process.stderr.write(`✗ ${name}\n${error.message}\n`)
    process.stderr.write(`evidence preserved at: ${work}\n`)
    process.exitCode = 1
  }
}

const sh = (cmd, options = {}) =>
  execSync(cmd, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })

const runBin = (args, options = {}) => {
  const result = execFileSync("node", [join(work, "dist", "bin.cjs"), ...args], {
    cwd: work,
    encoding: "utf8",
    ...options,
  })
  return result
}

const runBinExpectFail = (args, expectedExit) => {
  try {
    execFileSync("node", [join(work, "dist", "bin.cjs"), ...args], {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    if (error.status !== expectedExit) {
      throw new Error(
        `expected exit ${expectedExit}, got ${error.status}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`,
        { cause: error },
      )
    }
    return { stdout: error.stdout, stderr: error.stderr }
  }
  throw new Error(`expected exit ${expectedExit}, command succeeded`)
}

step("clean start: archive installs with the frozen lockfile", () => {
  execSync(`git archive HEAD | tar -x -C ${work}`, { cwd: root })
  if (!existsSync(join(work, "package-lock.json"))) {
    throw new Error("package-lock.json is not tracked — the template must ship its lockfile")
  }
  sh("npm ci --no-fund --no-audit")
})

step("git tooling: hooks install and commit messages are enforced", () => {
  sh("git init --initial-branch=main -q && git add -A")
  sh("npx lefthook install")
  sh('git -c user.email=contract@lasso.dev -c user.name=contract commit -q -m "chore: seed"')
  let rejected = false
  try {
    sh(
      'git -c user.email=contract@lasso.dev -c user.name=contract commit -q --allow-empty -m "bad message"',
    )
  } catch {
    rejected = true
  }
  if (!rejected) {
    throw new Error("commitlint accepted a non-conventional commit message")
  }
})

step("build: the template produces the shipped artifact", () => {
  sh("npx tsdown")
})

step("introspection works with no auth, network, config, or state", () => {
  const describe = JSON.parse(runBin(["describe", "--json"]))
  if (describe.status !== "ok" || describe.data.commands.length < 4) {
    throw new Error("describe payload incomplete")
  }
  const schema = JSON.parse(runBin(["schema", "--json"]))
  if (!String(schema.data.dialect).includes("2020-12")) {
    throw new Error("schema is not draft 2020-12")
  }
})

step("json success: exactly one valid envelope on stdout", () => {
  const stdout = runBin(["task", "list", "--json"])
  const lines = stdout.split("\n").filter((line) => line.length > 0)
  if (lines.length !== 1) {
    throw new Error(`expected 1 envelope line, got ${lines.length}`)
  }
  const envelope = JSON.parse(lines[0])
  if (envelope.schemaVersion !== "1" || envelope.status !== "ok") {
    throw new Error(`bad envelope: ${lines[0]}`)
  }
})

step("json failure classes produce documented codes and exits", () => {
  const usage = runBinExpectFail(["nonsense", "--json"], 64)
  if (JSON.parse(usage.stdout.trim()).error.code !== "invalid_usage") {
    throw new Error("unknown command must be invalid_usage")
  }
  const invalid = runBinExpectFail(["task", "create", "", "--yes", "--json"], 65)
  if (JSON.parse(invalid.stdout.trim()).error.code !== "invalid_data") {
    throw new Error("empty title must be invalid_data")
  }
})

step("confirmation protocol: exit 4, then confirmArgs completes the plan", () => {
  const first = runBinExpectFail(["task", "create", "Contract journey", "--json"], 4)
  const envelope = JSON.parse(first.stdout.trim())
  if (envelope.status !== "confirmation_required") {
    throw new Error("unconfirmed mutation must return confirmation_required")
  }
  const second = JSON.parse(runBin(envelope.confirmation.confirmArgs))
  if (second.data.created !== true) {
    throw new Error("confirmArgs replay did not apply the plan")
  }
})

step("dry run changes nothing", () => {
  runBin(["task", "create", "Never applied", "--dry-run", "--json"])
  const list = JSON.parse(runBin(["task", "list", "--json"]))
  const titles = list.data.items.map((item) => item.title)
  if (titles.includes("Never applied")) {
    throw new Error("--dry-run applied a change")
  }
})

step("idempotency: repeating the fixture mutation is stable", () => {
  runBin(["task", "create", "Idem", "--yes", "--json"])
  const repeat = JSON.parse(
    runBin(["task", "create", "Idem", "--yes", "--if-not-exists", "--json"]),
  )
  if (repeat.data.created !== false) {
    throw new Error("--if-not-exists re-run must report created: false")
  }
})

step("ndjson: every line validates and streams end with summary", () => {
  const stdout = runBin(["task", "list", "--format", "ndjson"])
  const events = stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
  if (events.at(-1).event !== "summary") {
    throw new Error("ndjson stream must end with a summary event")
  }
})

step("non-interactive safety: missing input fails fast, never hangs", () => {
  const start = Date.now()
  runBinExpectFail(["task", "create", "--json"], 64)
  if (Date.now() - start > 5000) {
    throw new Error("missing-argument failure took too long — was something waiting on input?")
  }
})

step("agent workflow: the command generator yields a green Fast profile", () => {
  sh("node scripts/new-command.mjs task ping")
  sh("npm run check")
})

step("rename journey: the renamed template stays green", () => {
  sh("node scripts/rename.mjs acme-cli")
  sh("npm run check")
  const renamedDescribe = JSON.parse(
    execFileSync("node", ["--experimental-strip-types", "src/bin.ts", "describe", "--json"], {
      cwd: work,
      encoding: "utf8",
    }),
  )
  if (renamedDescribe.data.cli.name !== "acme-cli") {
    throw new Error("describe still reports the old CLI name after rename")
  }
  sh("node scripts/rename.mjs lasso")
  sh("npm run check")
})

step("release hygiene: the pack contains only intended files", () => {
  const files = JSON.parse(sh("npm pack --dry-run --json"))[0].files.map((f) => f.path)
  const allowed = /^(bin\/|dist\/|package\.json$|README\.md$|LICENSE$)/
  const unexpected = files.filter((file) => !allowed.test(file))
  if (unexpected.length > 0) {
    throw new Error(`unexpected files in the pack: ${unexpected.join(", ")}`)
  }
})

if (!failed) {
  rmSync(work, { recursive: true, force: true })
  process.stderr.write("\nstarter contract green\n")
}
