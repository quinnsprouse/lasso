#!/usr/bin/env node
// Edit Feedback (PostToolUse on Edit|Write): after an agent edits a .ts,
// .mjs, .cjs, or .json file, format it and return lint, type, and Effect
// diagnostics while the agent still has the context to repair them. Types
// and Effect diagnostics require LASSO_POST_EDIT_FULL=1; the shared check
// command always runs both.
//
// PostToolUse runs after the edit has landed: exit 2 cannot undo it, but it
// puts the diagnostics in front of the agent as the next thing to fix. Exit 0
// passes. A missing toolchain reports the fix ("run npm ci") rather than
// silently passing or — worse — letting `npx` fetch a same-named package.
// Budget: Claude Code kills hooks at 120s (see .claude/settings.json), so the
// per-step timeouts below must sum to less than that.
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

// 4. Effect diagnostics on the edited file: floating Effects, missing
//    contexts, and generator slips surface now, not at check time.
const diagnostics = run(
  "effect-tsgo",
  ["diagnostics", "--file", rel, "--strict", "--format", "text"],
  25_000,
)
// Any failure blocks — a crashed or misconfigured diagnostics run is not a
// clean one; the output says which.
if (!diagnostics.ok) {
  block(`effect diagnostics for ${rel}:\n${diagnostics.output.slice(0, 4000)}`)
}
