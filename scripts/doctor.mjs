#!/usr/bin/env node
// Workspace doctor: verifies the environment and the toolchain's hidden
// state. Every check is a functional probe where possible — the Effect
// oxlint patch is verified by actually catching a planted floating Effect,
// not by looking for backup files. Pass --json for machine output.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

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

check("node version", () => {
  const version = process.version.slice(1)
  if (!versionAtLeast(version, "22.18.0")) {
    fail(`node ${version} is below the required 22.18`, "install Node 24 LTS")
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

check("git repository", () => {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8", stdio: "pipe" })
  } catch {
    fail("not a git repository", "run: git init --initial-branch=main && npm run setup")
  }
  return "repository present"
})

check("git hooks installed", () => {
  const hook = ".git/hooks/pre-commit"
  if (!existsSync(hook) || !readFileSync(hook, "utf8").includes("lefthook")) {
    fail("lefthook hooks are not installed", "run: npm run setup")
  }
  return "lefthook hooks present"
})

check("effect versions aligned", () => {
  const effect = JSON.parse(readFileSync("node_modules/effect/package.json", "utf8")).version
  const platform = JSON.parse(
    readFileSync("node_modules/@effect/platform-node/package.json", "utf8"),
  ).version
  if (effect !== platform) {
    fail(
      `effect ${effect} and @effect/platform-node ${platform} are out of lockstep`,
      "pin both packages to the same exact version and reinstall",
    )
  }
  return `effect ${effect}`
})

check("effect oxlint patch active", () => {
  // Functional probe: a floating Effect must trip the effecttsgo rule.
  // Type-aware lint only sees files inside tsconfig's include, so the probe
  // lives in src/ for the duration of one lint run and is always removed.
  const probe = join("src", `__doctor_probe_${process.pid}__.ts`)
  writeFileSync(
    probe,
    'import { Effect } from "effect"\nexport const f = () => {\n  Effect.succeed(1)\n  return 2\n}\n',
  )
  try {
    const output = (() => {
      try {
        return execFileSync("npx", ["oxlint", "--type-aware", probe], {
          encoding: "utf8",
          stdio: "pipe",
        })
      } catch (error) {
        return `${error.stdout ?? ""}${error.stderr ?? ""}`
      }
    })()
    if (!output.includes("effecttsgo(floating-effect)")) {
      fail(
        "the effecttsgo oxlint rules are not active — node_modules is unpatched",
        "run: npx effect-tsgo patch --oxlint (or reinstall: npm ci)",
      )
    }
  } finally {
    rmSync(probe, { force: true })
  }
  return "effecttsgo rules firing"
})

check("template identity", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  if (pkg.name === "lasso") {
    return "still the starter identity — run scripts/rename.mjs before publishing"
  }
  return `renamed to ${pkg.name}`
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
