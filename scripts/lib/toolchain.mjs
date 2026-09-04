// Toolchain resolution shared by the scripts and the Claude Code hooks.
//
// Every tool is run as `node <package entry>` resolved from node_modules, so:
//   - `npx` never runs: a missing install fails loudly instead of fetching a
//     same-named package from the registry (npx tsc → the unrelated tsc@2.0.4);
//   - the exact version in package-lock.json is the version that runs;
//   - no PATH lookup and no `.cmd` shims, so the same call works on Windows.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The repository root, derived from this file's location — never from cwd. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

/** Structural markers that identify a Lasso-derived workspace regardless of its name. */
const MARKERS = ["package.json", "src/meta.ts", "src/commands/index.ts", "scripts/verify.mjs"]

/** `dir` when it is a Lasso workspace (all markers present), else undefined. */
export const workspaceFrom = (dir) =>
  typeof dir === "string" && MARKERS.every((marker) => existsSync(join(dir, marker)))
    ? dir
    : undefined

/** Throws unless `dir` is a Lasso workspace. Mutating scripts call this before touching anything. */
export const assertWorkspace = (dir = repoRoot) => {
  const missing = MARKERS.filter((marker) => !existsSync(join(dir, marker)))
  if (missing.length > 0) {
    throw new Error(`${dir} is not a Lasso workspace (missing ${missing.join(", ")})`)
  }
  return dir
}

const PACKAGE_FOR = {
  tsc: "typescript",
  biome: "@biomejs/biome",
  oxlint: "oxlint",
  "effect-tsgo": "@effect/tsgo",
  vitest: "vitest",
  knip: "knip",
  tsdown: "tsdown",
  lefthook: "lefthook",
  publint: "publint",
  commitlint: "@commitlint/cli",
}

/** An error carrying an executable `fix`, the same shape the CLI's AppError uses. */
const toolchainError = (message, fix) => Object.assign(new Error(message), { fix })

/** Fails with an actionable message when any toolchain package is not installed. */
export const ensureInstalled = (dir = repoRoot) => {
  const missing = Object.values(PACKAGE_FOR).filter(
    (pkg) => !existsSync(join(dir, "node_modules", ...pkg.split("/"), "package.json")),
  )
  if (missing.length > 0) {
    throw toolchainError(
      `node_modules is missing or incomplete (${missing.join(", ")})`,
      "run: npm ci",
    )
  }
}

/**
 * ensureInstalled for scripts: prints the problem and its fix on one line each
 * and exits 78 (config error) instead of throwing a stack trace at the user.
 */
export const requireToolchain = (dir = repoRoot) => {
  try {
    ensureInstalled(dir)
  } catch (error) {
    process.stderr.write(`${error.message}\nfix: ${error.fix}\n`)
    process.exit(78)
  }
}

/** Resolves a tool to `[node, entry]` — the JS entry of its package bin. */
export const tool = (name, dir = repoRoot) => {
  const pkgName = PACKAGE_FOR[name]
  if (pkgName === undefined) {
    throw toolchainError(`unknown tool "${name}"`, "add it to scripts/lib/toolchain.mjs")
  }
  const pkgDir = join(dir, "node_modules", ...pkgName.split("/"))
  const pkgJson = join(pkgDir, "package.json")
  if (!existsSync(pkgJson)) {
    throw toolchainError(`${pkgName} is not installed`, "run: npm ci")
  }
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8"))
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name]
  if (typeof bin !== "string") {
    throw toolchainError(`${pkgName} declares no "${name}" bin`, "check the package version")
  }
  return [process.execPath, join(pkgDir, bin)]
}

/** spawnSync a tool with inherited stdio; returns the spawn result. */
export const spawnTool = (name, args, options = {}) => {
  const [node, entry] = tool(name, options.cwd ?? repoRoot)
  return spawnSync(node, [entry, ...args], { stdio: "inherit", cwd: repoRoot, ...options })
}

/** execFileSync a tool, capturing output; throws like execFileSync does. */
export const execTool = (name, args, options = {}) => {
  const [node, entry] = tool(name, options.cwd ?? repoRoot)
  return execFileSync(node, [entry, ...args], { encoding: "utf8", cwd: repoRoot, ...options })
}
