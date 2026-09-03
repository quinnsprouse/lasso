#!/usr/bin/env node
// Guard (PreToolUse on Bash, Edit, Write): refuses the handful of actions
// that bypass the repository's mechanical gates. Exit 2 with the reason on
// stderr blocks the tool call; the agent sees the reason and can choose a
// compliant path. Everything not listed here is allowed.
//
// Commands are split into argv segments and judged by argv, not by substring
// matching, so a commit message that mentions `--no-verify` passes and
// `git -c core.hooksPath=/dev/null commit` does not. The splitter is a
// sketch of the shell, not a shell: it exists to catch an agent's honest
// command, and the git hooks and CI remain the real gates.
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"

const { repoRoot, workspaceFrom } = await import("../../scripts/lib/toolchain.mjs")

let input
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  process.exit(0)
}
// In a Claude-managed worktree the hook script still lives in the original
// project, but the edits land in the worktree: judge paths against the
// workspace the tool call runs in.
const root = workspaceFrom(input?.cwd) ?? repoRoot

const deny = (reason, fix) => {
  process.stderr.write(`guard: ${reason}\nfix: ${fix}\n`)
  process.exit(2)
}

// ---------------------------------------------------------------- tokenizer

/** Index just past the `)` closing a `$(` whose body starts at `from`; quotes inside count for nothing. */
const closeOf = (text, from) => {
  let depth = 1
  let quote = null
  for (let j = from; j < text.length; j++) {
    const c = text[j]
    if (quote !== null) {
      if (c === quote) {
        quote = null
      } else if (c === "\\") {
        j += 1
      }
    } else if (c === "\\") {
      j += 1
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === "(") {
      depth += 1
    } else if (c === ")" && (depth -= 1) === 0) {
      return j + 1
    }
  }
  return text.length
}

/**
 * Splits a command into argv segments. Quotes group; newline `;` `|` `&`
 * `(` `)` split; `#` comments and backslash-newlines vanish. A `$(…)` or
 * backtick body and an unquoted heredoc body are returned as `bodies`:
 * commands of their own, judged recursively. A quoted heredoc (`<<'EOF'`)
 * is literal and skipped, so writing a file never trips a rule.
 */
const tokenize = (command) => {
  const segments = []
  const joins = []
  const bodies = []
  const heredocs = []
  let current = []
  let token = ""
  let has = false
  let quote = null
  const endToken = () => {
    if (has) {
      current.push(token)
    }
    token = ""
    has = false
  }
  const endSegment = (by = "") => {
    endToken()
    if (current.length > 0) {
      segments.push(current)
      joins.push(by)
    }
    current = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote !== "'" && c === "\\" && command[i + 1] === "\n") {
      i += 1
    } else if (quote !== "'" && c === "$" && command[i + 1] === "(") {
      const end = closeOf(command, i + 2)
      bodies.push(command.slice(i + 2, command[end - 1] === ")" ? end - 1 : end))
      token += command.slice(i, end)
      has = true
      i = end - 1
    } else if (quote !== "'" && c === "`") {
      const end = command.indexOf("`", i + 1)
      const stop = end === -1 ? command.length : end
      bodies.push(command.slice(i + 1, stop))
      token += command.slice(i, stop + 1)
      has = true
      i = stop
    } else if (quote !== null) {
      if (c === quote) {
        quote = null
      } else if (c === "\\" && quote === '"' && i + 1 < command.length) {
        token += command[++i]
      } else {
        token += c
      }
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === "\\" && i + 1 < command.length) {
      token += command[++i]
      has = true
    } else if (c === "#" && !has) {
      while (i + 1 < command.length && command[i + 1] !== "\n") {
        i += 1
      }
    } else if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      endToken()
      let j = i + 2
      const strip = command[j] === "-"
      j += strip ? 1 : 0
      while (command[j] === " " || command[j] === "\t") {
        j += 1
      }
      const open = command[j]
      const quoted = open === "'" || open === '"' || open === "\\"
      let delimiter = ""
      if (open === "'" || open === '"') {
        const close = command.indexOf(open, j + 1)
        delimiter = command.slice(j + 1, close === -1 ? command.length : close)
        j = close === -1 ? command.length : close + 1
      } else {
        j += open === "\\" ? 1 : 0
        while (j < command.length && !/[\s;|&<>()]/.test(command[j])) {
          delimiter += command[j++]
        }
      }
      heredocs.push({ delimiter, quoted, strip })
      i = j - 1
    } else if (c === "\n" && heredocs.length > 0) {
      endSegment(c)
      let j = i + 1
      for (const doc of heredocs) {
        const lines = []
        while (j < command.length) {
          const eol = command.indexOf("\n", j)
          const line = command.slice(j, eol === -1 ? command.length : eol)
          j = eol === -1 ? command.length : eol + 1
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
            break
          }
          lines.push(line)
        }
        if (!doc.quoted) {
          bodies.push(lines.join("\n"))
        }
      }
      heredocs.length = 0
      i = j - 1
    } else if (c === "|" && command[i + 1] === "|") {
      endSegment("||")
      i += 1
    } else if (c === "\n" || ";|&()".includes(c)) {
      endSegment(c)
    } else if (/\s/.test(c)) {
      endToken()
    } else {
      token += c
      has = true
    }
  }
  endSegment()
  return { segments, joins, bodies }
}

const WRAPPERS = new Set("env sudo command exec time nice nohup builtin xargs corepack".split(" "))
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
/** Wrapper options that take the next token as their value (`sudo -u root`, `xargs -I {}`). */
const WRAPPER_VALUED = {
  sudo: new Set("-u -g -p -h -C --user --group --prompt".split(" ")),
  env: new Set("-u -C --unset --chdir".split(" ")),
  xargs: new Set("-I -n -P -L -d -s -E".split(" ")),
  nice: new Set(["-n"]),
  time: new Set("-f -o".split(" ")),
}
/** Keywords that may precede the command word in a compound command. */
const KEYWORDS = new Set("if then else elif while until do ! {".split(" "))
/** Package-manager global options that may precede exec/x/dlx. */
const PM_VALUED = new Set("-C --prefix --registry --loglevel --filter -F -w --workspace".split(" "))

/**
 * One segment to its judged form: `VAR=value` prefixes become `<assign>`
 * pseudo-segments (the LEFTHOOK rule reads them), keywords and wrappers with
 * their options are dropped, and `export` is an assignment too.
 */
const normalize = (tokens) => {
  const out = []
  let i = 0
  while (i < tokens.length) {
    const word = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      out.push(["<assign>", word])
      i += 1
    } else if (KEYWORDS.has(word)) {
      i += 1
    } else if (WRAPPERS.has(basename(word))) {
      const valued = WRAPPER_VALUED[basename(word)]
      i += 1
      while (i < tokens.length && tokens[i].startsWith("-")) {
        i += valued?.has(tokens[i]) ? 2 : 1
      }
    } else {
      break
    }
  }
  const rest = tokens.slice(i)
  if (rest[0] === "export") {
    for (const assignment of rest.slice(1)) {
      out.push(["<assign>", assignment])
    }
    return out
  }
  if (rest.length > 0) {
    out.push([basename(rest[0]), ...rest.slice(1)])
  }
  return out
}

// ------------------------------------------------------------------- rules

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

const judgeRm = (args) => {
  const flags = args.filter((arg) => arg.startsWith("-"))
  const targets = args.filter((arg) => !arg.startsWith("-"))
  const recursive = flags.some((flag) => flag === "--recursive" || /^-[a-zA-Z]*[rR]/.test(flag))
  if (recursive && (targets.length === 0 || targets.some((target) => /\$\(|`/.test(target)))) {
    // `rm -rf $(pwd)`: a target that is a substitution cannot be judged.
    deny(
      "recursive rm whose target comes from a substitution or pipe cannot be checked",
      "name the exact directories to remove",
    )
  }
  for (const target of targets) {
    const clean = target.replace(/\/+$/, "")
    const name = basename(clean)
    const insideGit = /(^|\/)\.git(\/|$)/.test(clean)
    // A glob that could expand to the lockfile is refused; other expansions
    // are the shell's business (the git hooks and CI remain the real gates).
    const lockGlob = /[*?[]/.test(name) && name.startsWith("package")
    if (name === "package-lock.json" || insideGit || lockGlob) {
      deny(
        `rm of ${name} destroys the reproducibility the kit depends on`,
        "if the lockfile is stale, run npm install and review the diff",
      )
    }
    if (
      recursive &&
      (name === "." || name === "" || target === "*" || resolve(root, target) === root)
    ) {
      deny(
        "recursive rm of the repository root would delete .git and the lockfile",
        "name the specific files or directories to remove",
      )
    }
  }
}

const PROTECTED_NAME = /(^|\/)(\.git|package-lock\.json)$|^package(-\*|\*|-lock)/

const judgePackageManager = (args) => {
  // Skip global options before the subcommand: npm --silent exec -- vitest.
  let at = 0
  while (at < args.length && args[at].startsWith("-")) {
    at += PM_VALUED.has(args[at]) ? 2 : 1
  }
  if (["exec", "x", "dlx"].includes(args[at])) {
    const rest = args.slice(at + 1)
    // `npm exec --call 'tsc --noEmit'` / `-c` / `--call=`: judge the body's first word.
    for (let i = 0; i < rest.length; i++) {
      const [name, inline] = rest[i].includes("=")
        ? [rest[i].slice(0, rest[i].indexOf("=")), rest[i].slice(rest[i].indexOf("=") + 1)]
        : [rest[i], undefined]
      if (name === "--call" || name === "-c") {
        // The body is a shell command: every rule applies, and its bare
        // executables are judged as if npx had launched them.
        const body = inline ?? rest[i + 1] ?? ""
        judgeCommand(body)
        for (const [head] of tokenize(body).segments.flatMap(normalize)) {
          judgeExecutor([head])
        }
      }
    }
    judgeExecutor(rest.filter((arg) => arg !== "--"))
  }
}

/** Command rules, by executable name. Each judge denies or returns. */
const COMMAND_RULES = [
  { heads: ["git"], judge: judgeGit },
  { heads: ["npx", "bunx"], judge: judgeExecutor },
  { heads: ["npm", "pnpm", "yarn", "bun"], judge: judgePackageManager },
  { heads: ["rm"], judge: judgeRm },
]

/** A find over a protected name that deletes in the same segment (-delete, -exec rm). */
const findDeletesInPlace = ([head, ...args]) =>
  basename(head) === "find" &&
  args.some((arg) => PROTECTED_NAME.test(arg)) &&
  (args.includes("-delete") ||
    (args.some((arg) => arg === "-exec" || arg === "-execdir") &&
      args.some((arg) => basename(arg) === "rm")))

/** Judges normalized segments: assignments, the command rule table, and in-place find deletes. */
const judgeSegments = (segments) => {
  for (const segment of segments) {
    if (findDeletesInPlace(segment)) {
      deny("a find over .git or the lockfile that deletes", "use git and npm to manage those")
    }
  }
  for (const [head, ...args] of segments) {
    if (head === "<assign>") {
      if (/^LEFTHOOK(_SKIP|_EXCLUDE)?=/.test(args[0] ?? "")) {
        deny(
          "LEFTHOOK environment overrides disable the git hooks",
          "run the gate that would have failed: npm run check or npm run check:push",
        )
      }
      continue
    }
    for (const rule of COMMAND_RULES) {
      if (rule.heads.includes(head)) {
        rule.judge(args)
      }
    }
  }
}

/** Judges one command: its substitution and shell bodies first, then every segment. */
const judgeCommand = (command, depth = 0) => {
  if (depth > 3) {
    return
  }
  const { segments, joins, bodies } = tokenize(command)
  for (const body of bodies) {
    judgeCommand(body, depth + 1)
  }
  const normalized = segments.map(normalize)
  normalized.forEach((forms, index) => {
    for (const [head, ...args] of forms) {
      if (SHELLS.has(head)) {
        const at = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
        if (at !== -1 && args[at + 1] !== undefined) {
          judgeCommand(args[at + 1], depth + 1)
        }
      } else if (head === "eval") {
        judgeCommand(args.join(" "), depth + 1)
      }
      // `find … | xargs rm`: the delete sits in the segment a pipe leads to.
      if (
        head === "find" &&
        args.some((arg) => PROTECTED_NAME.test(arg)) &&
        joins[index] === "|" &&
        (normalized[index + 1] ?? []).some(([next]) => next === "rm")
      ) {
        deny("a find over .git or the lockfile piped into rm", "use git and npm to manage those")
      }
    }
  })
  judgeSegments(normalized.flat())
}

// ------------------------------------------------------------------- paths

/**
 * Real path of `target`, resolving the nearest existing ancestor (and any
 * dangling symlink on the way) so a link cannot hide a protected path.
 */
const realTarget = (target, depth = 0) => {
  let existing = target
  const trailing = []
  while (!existsSync(existing)) {
    const link = lstatSync(existing, { throwIfNoEntry: false })
    if (link?.isSymbolicLink() && depth < 8) {
      const pointed = resolve(dirname(existing), readlinkSync(existing))
      return realTarget(join(pointed, ...trailing), depth + 1)
    }
    trailing.unshift(basename(existing))
    const parent = dirname(existing)
    if (parent === existing) {
      return target
    }
    existing = parent
  }
  return join(realpathSync(existing), ...trailing)
}

const PROTECTED = [
  {
    test: (p) => p.startsWith("dist/"),
    reason: "dist/ is a build output",
    fix: "edit src/ and run npm run build",
  },
  {
    test: (p) => p.startsWith("coverage/"),
    reason: "coverage/ is generated",
    fix: "run npm run test:coverage",
  },
  {
    test: (p) => p.startsWith("node_modules/"),
    reason: "node_modules is installed, not edited",
    fix: "change package.json and run npm install",
  },
  {
    test: (p) => p.startsWith(".git/"),
    reason: ".git internals are managed by git",
    fix: "use git commands",
  },
  {
    test: (p) => p === "package-lock.json",
    reason: "the lockfile is generated by npm",
    fix: "run npm install <pkg> or npm update and commit the result",
  },
  {
    test: (p) => p === "test/contract/surface.snapshot.json",
    reason: "the surface snapshot is generated",
    fix: "run npm run surface:update after an additive surface change",
  },
  {
    test: (p) => p === "src/guides/catalog.generated.ts",
    reason: "the guide catalog is generated from guides/topics/*.md",
    fix: "edit the Markdown topic, then run node scripts/guides.mjs",
  },
  {
    test: (p) => p.startsWith(".lasso/"),
    reason: ".lasso/ is runtime state",
    fix: "use the CLI to change state",
  },
]

const judgePath = (filePath) => {
  const realRoot = realpathSync(root)
  const rel = relative(realRoot, realTarget(resolve(root, filePath))).replaceAll("\\", "/")
  if (rel.startsWith("..")) {
    return
  }
  for (const rule of PROTECTED) {
    if (rule.test(rel)) {
      deny(`${rel}: ${rule.reason}`, rule.fix)
    }
  }
}

// -------------------------------------------------------------------- main

const toolName = input?.tool_name
const toolInput = input?.tool_input ?? {}

if (toolName === "Bash" && typeof toolInput.command === "string") {
  judgeCommand(toolInput.command)
}
if (
  (toolName === "Edit" || toolName === "Write") &&
  typeof toolInput.file_path === "string" &&
  toolInput.file_path.length > 0
) {
  judgePath(toolInput.file_path)
}
process.exit(0)
