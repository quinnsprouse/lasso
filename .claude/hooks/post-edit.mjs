#!/usr/bin/env node
// PostToolUse cannot undo an edit; exit 2 returns actionable format/lint failures.
// Full project typechecking is opt-in. Per-step timeouts stay below the hook's 120s budget.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

const { repoRoot, ensureInstalled, tool, workspaceFrom } = await import(
  "../../scripts/lib/toolchain.mjs"
)

const readInput = () => {
  try {
    return JSON.parse(readFileSync(0, "utf8"))
  } catch {
    return null
  }
}

const input = readInput()
const filePath = input?.tool_input?.file_path
if (typeof filePath !== "string") {
  process.exit(0)
}
// In a Claude-managed worktree the edit lands in the worktree, not where this
// script lives: run every tool against the workspace of the tool call.
const root = workspaceFrom(input?.cwd) ?? repoRoot
const absolute = resolve(root, filePath)
const rel = relative(root, absolute)
// Only files inside the repo, and only the kinds Biome and the type-aware
// tools understand (Markdown and YAML have no formatter here; lefthook's
// format step skips them the same way).
if (rel.startsWith("..") || !/\.(ts|mjs|cjs|json)$/.test(rel)) {
  process.exit(0)
}
if (/^(node_modules|dist|coverage|\.lasso)\//.test(rel)) {
  process.exit(0)
}

const block = (message) => {
  process.stderr.write(`${message.trimEnd()}\n`)
  process.exit(2)
}

try {
  ensureInstalled(root)
} catch (error) {
  block(`post-edit hook: ${error.message}\nfix: ${error.fix}`)
}

/** Runs a tool; returns { ok, output }. A timeout counts as a failure so it is never silently green. */
const run = (name, args, timeout) => {
  try {
    const [node, entry] = tool(name, root)
    const output = execFileSync(node, [entry, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    })
    return { ok: true, output }
  } catch (error) {
    if (error.fix !== undefined) {
      return { ok: false, output: `${error.message}\nfix: ${error.fix}\n` }
    }
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`
    const reason =
      error.code === "ETIMEDOUT" || error.signal === "SIGTERM"
        ? `${name} timed out\n`
        : output.length === 0
          ? `${name} failed: ${error.message}\n`
          : ""
    return { ok: false, output: `${reason}${output}` }
  }
}

// 1. Format. Biome fails on syntax errors, so a broken .mjs, .cjs, or .json
//    edit is reported instead of ignored.
const format = run("biome", ["format", "--write", rel], 15_000)
if (!format.ok) {
  block(`biome could not format ${rel}:\n${format.output.slice(0, 4000)}`)
}

const isScript = /\.(ts|mjs|cjs)$/.test(rel)
if (!isScript) {
  process.exit(0)
}

// 2. Lint the edited file with the type-aware rules: the architectural rules
//    (parser containment, process/fs/console bans, Effect misuse) live here.
const lint = run("oxlint", ["--type-aware", "--deny-warnings", rel], 30_000)
if (!lint.ok) {
  block(`oxlint found problems in ${rel}:\n${lint.output.slice(0, 4000)}`)
}

// Opt in when immediate project-wide feedback is useful; npm run check always runs it.
if (!rel.endsWith(".ts") || process.env.LASSO_POST_EDIT_FULL !== "1") {
  process.exit(0)
}

// 3. Types for the whole project: an edit can break a caller elsewhere.
const types = run("tsc", ["--noEmit"], 45_000)
if (!types.ok) {
  block(`tsc reported errors:\n${types.output.slice(0, 4000)}`)
}
