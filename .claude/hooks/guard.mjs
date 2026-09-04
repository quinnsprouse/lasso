#!/usr/bin/env node
// Accident prevention for direct commands and generated-file edits.
// Shell programs are outside this hook's scope. Git hooks and CI run the checks.
import { readFileSync } from "node:fs"
import { basename, relative, resolve } from "node:path"
import { repoRoot, workspaceFrom } from "../../scripts/lib/toolchain.mjs"

let input
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  process.exit(0)
}
const root = workspaceFrom(input?.cwd) ?? repoRoot
const deny = (reason, fix) => {
  process.stderr.write(`guard: ${reason}\nfix: ${fix}\n`)
  process.exit(2)
}

// Read one literal argv. Decline shell syntax rather than interpreting it.
// Quotes preserve spaces, including commit messages that mention blocked flags.
const directArgs = (command) => {
  const args = []
  let word = ""
  let started = false
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "\n" || (quote !== "'" && /[$`]/.test(c))) return undefined
    if (quote !== null) {
      if (c === quote) quote = null
      else if (c === "\\" && quote === '"') return undefined
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (/[;|&()< >#\\]/.test(c) && c !== " ") {
      return undefined
    } else if (/\s/.test(c)) {
      if (started) args.push(word)
      word = ""
      started = false
    } else {
      word += c
      started = true
    }
  }
  if (quote !== null) return undefined
  if (started) args.push(word)
  return args
}

/** The branch a refspec updates: the part after ":" or the whole spec. */
const destination = (spec) =>
  basename(spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec)
const isMain = (ref) => ["main", "master"].includes(basename(ref))

const GIT_GLOBAL_WITH_VALUE = new Set(
  "-c -C --git-dir --work-tree --namespace --exec-path --config-env".split(" "),
)
/** git options that take a value, dropped so `-m "-n"` is a message, not a flag. */
const GIT_VALUED = new Set(
  `-m --message -F --file --author --date -C --reuse-message -c --reedit-message
   --trailer --fixup --squash -t --template -o --push-option --receive-pack --exec --repo`.split(
    /\s+/,
  ),
)

const judgeGit = (args) => {
  // Global options come before the subcommand: `git -c a=b -C dir push …`.
  let i = 0
  const globals = []
  while (i < args.length && args[i].startsWith("-")) {
    const opt = args[i]
    if (GIT_GLOBAL_WITH_VALUE.has(opt)) {
      globals.push(`${opt}${args[i + 1] ?? ""}`)
      i += 2
    } else {
      globals.push(opt)
      i += 1
    }
  }
  if (globals.some((opt) => /^(-c\s*|--config-env=?)core\.hooksPath/i.test(opt))) {
    deny(
      "overriding core.hooksPath for one command detaches the lefthook gates",
      "run the command without overriding core.hooksPath",
    )
  }
  const sub = args[i]
  const rest = []
  for (let j = i + 1; j < args.length; j++) {
    if (GIT_VALUED.has(args[j])) {
      j += 1
      continue
    }
    rest.push(args[j])
  }
  const has = (...names) => rest.some((arg) => names.includes(arg))
  const shortCluster = (letter) =>
    rest.some((arg) => /^-[a-zA-Z]+$/.test(arg) && arg.includes(letter))

  if (sub === "commit" && (has("--no-verify") || shortCluster("n"))) {
    deny(
      "git commit --no-verify skips the pre-commit and commit-msg gates",
      "fix what the hook reports, then commit normally",
    )
  }
  if ((sub === "merge" || sub === "rebase") && has("--no-verify")) {
    deny(`git ${sub} --no-verify skips the hook gates`, "run without --no-verify")
  }
  if (sub === "push") {
    if (has("--no-verify")) {
      deny(
        "git push --no-verify skips the pre-push gate (npm run check:push)",
        "run npm run check:push, fix what fails, then push normally",
      )
    }
    const positional = rest.filter((arg) => !arg.startsWith("-") || arg.startsWith("+"))
    const refspecs = positional.slice(1)
    const forced =
      has("-f", "--force", "--force-if-includes", "--mirror") ||
      rest.some((arg) => arg.startsWith("--force-with-lease") || arg.startsWith("+")) ||
      shortCluster("f")
    if (forced) {
      const targets = refspecs.map((spec) => spec.replace(/^\+/, ""))
      // A source-only symbolic ref (HEAD, @) lands on the current branch, which may be main.
      const symbolic = targets.some((spec) => !spec.includes(":") && /^(HEAD|@)(~|\^|$)/.test(spec))
      if (
        symbolic ||
        targets.length === 0 ||
        targets.some((spec) => isMain(destination(spec))) ||
        has("--all", "--mirror")
      ) {
        deny(
          "force-pushing main (or an unnamed ref, which may be main) rewrites shared history",
          "push a named feature branch: git push --force-with-lease origin <branch>",
        )
      }
    }
    // Deleting main is a rewrite of shared history too: `push origin :main`
    // and `push --delete origin main`.
    const deletes = has("--delete", "-d")
      ? refspecs
      : refspecs.filter((spec) => spec.startsWith(":")).map((spec) => spec.slice(1))
    if (deletes.some(isMain)) {
      deny("deleting main on the remote destroys shared history", "delete a feature branch instead")
    }
  }
  if (sub === "config" && rest.some((arg) => /core\.hooksPath/i.test(arg))) {
    const readOnly = has("--get", "--get-all", "--get-regexp", "-l", "--list", "--show-origin")
    if (!readOnly) {
      deny(
        "re-pointing core.hooksPath detaches the lefthook gates",
        "leave the hooks path alone; npm run setup restores the hooks",
      )
    }
  }
}

const TOOL_WORDS = new Set(
  `tsc tsgo biome oxlint effect-tsgo vitest knip tsdown lefthook publint commitlint
   typescript @biomejs/biome @effect/tsgo @commitlint/cli oxlint-tsgolint`.split(/\s+/),
)
const stripVersion = (spec) => spec.replace(/(.)@[^@/]+$/, "$1")

const judgeExecutor = (args) => {
  // The executable is the first non-option token; --package/-p name what npx installs.
  const candidates = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") {
      candidates.push(args[i + 1] ?? "")
      break
    }
    if (arg.startsWith("--package=")) {
      candidates.push(arg.slice("--package=".length))
    } else if (arg === "--package" || arg === "-p") {
      candidates.push(args[i + 1] ?? "")
      i += 1
    } else if (arg.startsWith("-")) {
      continue
    } else {
      candidates.push(arg)
      break
    }
  }
  if (candidates.some((arg) => TOOL_WORDS.has(arg) || TOOL_WORDS.has(stripVersion(arg)))) {
    deny(
      "npx-style execution may fetch a same-named or unpinned package from the registry",
      "use the npm script (npm run check, lint, typecheck, fmt, build); tools resolve from node_modules",
    )
  }
}

const judgeCommand = (command) => {
  const args = directArgs(command)
  if (args === undefined) return
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? "")) {
    const assignment = args.shift()
    if (/^LEFTHOOK=(0|false)$/.test(assignment) || /^LEFTHOOK_(SKIP|EXCLUDE)=.+/.test(assignment)) {
      deny("disabling git hooks", "run npm run check and repair the reported failure")
    }
  }
  const head = basename(args.shift() ?? "")
  if (head === "git") judgeGit(args)
  if (head === "npx" || head === "bunx") judgeExecutor(args)
  if (["npm", "pnpm", "yarn", "bun"].includes(head) && ["exec", "x", "dlx"].includes(args[0])) {
    judgeExecutor(args.slice(1))
  }
  if (head === "rm") {
    const recursive = args.some((arg) => arg === "--recursive" || /^-[a-zA-Z]*[rR]/.test(arg))
    for (const target of args.filter((arg) => !arg.startsWith("-"))) {
      if (
        /(^|\/)\.git(\/|$)/.test(target) ||
        basename(target) === "package-lock.json" ||
        (recursive && resolve(root, target) === root)
      ) {
        deny(
          "removing git metadata, the lockfile, or the repository",
          "name the files to remove; use npm to update the lockfile",
        )
      }
    }
  }
}

const PROTECTED = [
  [/^(dist|coverage|node_modules|\.git)\//, "edit source files or use the owning tool"],
  [/^\.lasso\//, "use the CLI to change state"],
  [/^package-lock\.json$/, "run npm install or npm update"],
  [/^test\/contract\/surface\.snapshot\.json$/, "run npm run surface:update and review the diff"],
  [/^src\/guides\/catalog\.generated\.ts$/, "edit guides/topics and run node scripts/guides.mjs"],
]

const tool = input?.tool_input ?? {}
if (input?.tool_name === "Bash" && typeof tool.command === "string") judgeCommand(tool.command)
if (["Edit", "Write"].includes(input?.tool_name) && typeof tool.file_path === "string") {
  const path = relative(root, resolve(root, tool.file_path)).replaceAll("\\", "/")
  for (const [pattern, fix] of PROTECTED) {
    if (pattern.test(path)) deny(`${path} is managed by a tool`, fix)
  }
}
