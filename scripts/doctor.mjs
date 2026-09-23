#!/usr/bin/env node
// Workspace doctor: verifies the environment and the toolchain's hidden
// state. Every check is a functional probe where possible — the Effect
// oxlint patch is verified by actually catching a planted floating Effect,
// not by looking for backup files. Pass --json for machine output.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { ensureInstalled, execTool, repoRoot } from "./lib/toolchain.mjs"

const asJson = process.argv.includes("--json")
const checks = []

const check = (name, fn) => {
  try {
    const result = fn()
    checks.push({ name, ok: true, detail: result ?? "ok" })
  } catch (error) {
    checks.push({
      name,
      ok: false,
      detail: error.message,
      ...(error.fix !== undefined ? { fix: error.fix } : {}),
    })
  }
}

const fail = (message, fix) => {
  const error = new Error(message)
  error.fix = fix
  throw error
}

const versionAtLeast = (actual, wanted) => {
  const a = actual.split(".").map(Number)
  const w = wanted.split(".").map(Number)
  for (let i = 0; i < w.length; i++) {
    if ((a[i] ?? 0) > w[i]) return true
    if ((a[i] ?? 0) < w[i]) return false
  }
  return true
}

// The dev toolchain (tsdown, Vitest) installs on these lines only; the
// published CLI itself runs on any Node >= 22.19 (package.json engines).
check("node version", () => {
  const version = process.version.slice(1)
  const [major] = version.split(".").map(Number)
  const supported =
    (major === 22 && versionAtLeast(version, "22.19.0")) ||
    (major === 24 && versionAtLeast(version, "24.11.0")) ||
    major >= 26
  if (!supported) {
    fail(
      `node ${version} cannot install the dev toolchain (needs ^22.19, ^24.11, or >=26)`,
      "install Node 24 LTS",
    )
  }
  return `node ${version}`
})

check("npm version", () => {
  const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()
  if (!versionAtLeast(version, "10.0.0")) {
    fail(`npm ${version} is below the required 10`, "upgrade npm: npm install -g npm@latest")
  }
  return `npm ${version}`
})

check("dependencies installed", () => {
  try {
    ensureInstalled(repoRoot)
  } catch (error) {
    fail(error.message, error.fix)
  }
  return "node_modules present"
})

check("git repository", () => {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    })
  } catch {
    fail("not a git repository", "run: git init --initial-branch=main && npm run setup")
  }
  return "repository present"
})

check("git hooks installed", () => {
  // --git-path resolves the hooks directory in a linked worktree too, where .git is a file.
  const hook = resolve(
    repoRoot,
    execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim(),
  )
  if (!existsSync(hook) || !readFileSync(hook, "utf8").includes("lefthook")) {
    fail("lefthook hooks are not installed", "run: npm run setup")
  }
  return "lefthook hooks present"
})

const installedVersion = (pkg) => {
  try {
    return JSON.parse(readFileSync(join(repoRoot, "node_modules", pkg, "package.json"), "utf8"))
      .version
  } catch (error) {
    return fail(`${pkg} is not installed: ${error.message}`, "run: npm ci")
  }
}

check("effect versions aligned", () => {
  const effect = installedVersion("effect")
  const drifted = ["@effect/platform-node", "@effect/vitest"]
    .map((pkg) => [pkg, installedVersion(pkg)])
    .filter(([, version]) => version !== effect)
  if (drifted.length > 0) {
    fail(
      `effect ${effect} and ${drifted.map(([pkg, version]) => `${pkg} ${version}`).join(", ")} are out of lockstep`,
      `pin effect, @effect/platform-node, and @effect/vitest to the same exact version and reinstall`,
    )
  }
  return `effect ${effect}`
})

check("effect oxlint patch active", () => {
  // Functional probe: a floating Effect must trip the effecttsgo rule.
  // Type-aware lint only sees files inside tsconfig's include, so the probe
  // lives in src/ for the duration of one lint run and is always removed.
  const probe = join("src", `__doctor_probe_${process.pid}__.ts`)
  // A listener defers SIGINT/SIGTERM until the probe is removed below; without
  // one, a kill mid-lint would leave the probe to fail every later lint run.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      process.exitCode = 130
    })
  }
  writeFileSync(
    join(repoRoot, probe),
    'import { Effect } from "effect"\nexport const f = () => {\n  Effect.succeed(1)\n  return 2\n}\n',
  )
  try {
    const output = (() => {
      try {
        return execTool("oxlint", ["--type-aware", probe], { stdio: "pipe" })
      } catch (error) {
        return `${error.stdout ?? ""}${error.stderr ?? ""}`
      }
    })()
    if (!output.includes("effecttsgo(floating-effect)")) {
      fail(
        "the effecttsgo oxlint rules are not active — node_modules is unpatched",
        "run: npm run prepare (re-applies the oxlint patch), or reinstall: npm ci",
      )
    }
  } finally {
    rmSync(join(repoRoot, probe), { force: true })
  }
  return "effecttsgo rules firing"
})

check("template identity", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  const binName = Object.keys(pkg.bin)[0]
  // Spelled in two halves so scripts/rename.mjs (which rewrites every whole
  // word occurrence of the starter name) leaves this sentinel alone.
  const starterName = ["las", "so"].join("")
  if (binName === starterName) {
    return "still the starter identity — run scripts/rename.mjs before publishing"
  }
  return `renamed to ${binName}`
})

const failed = checks.filter((entry) => !entry.ok)
if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ status: failed.length === 0 ? "ok" : "error", checks })}\n`,
  )
} else {
  for (const entry of checks) {
    process.stderr.write(`${entry.ok ? "✓" : "✗"} ${entry.name} — ${entry.detail}\n`)
    if (!entry.ok && entry.fix !== undefined) {
      process.stderr.write(`  fix: ${entry.fix}\n`)
    }
  }
  process.stderr.write(
    failed.length === 0 ? "\nworkspace healthy\n" : `\n${failed.length} problem(s)\n`,
  )
}
process.exitCode = failed.length === 0 ? 0 : 1
