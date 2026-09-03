#!/usr/bin/env node
// Guard (PreToolUse on Bash, Edit, Write): refuses the handful of actions
// that bypass the repository's mechanical gates. Exit 2 with the reason on
// stderr blocks the tool call; the agent sees the reason and can choose a
// compliant path. Everything not listed here is allowed.
//
// Commands are tokenized (quotes respected; newlines, `;`, `|`, `&`, `(`,
// `$(…)`, and backticks split segments; `sh -c`/`eval` bodies re-tokenized;
// env/sudo/xargs wrappers and VAR=value prefixes stripped; git global options
// and option values parsed) and judged by argv, not by substring matching, so
// a commit message that mentions `--no-verify` passes and
// `git -c core.hooksPath=/dev/null commit` does not.
// This is a speed bump for an agent, not a security boundary.
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

/** The separator that ended each top-level segment (by index), for pipeline-aware rules. */
const joiners = new WeakMap()
/** Command-substitution bodies found inside a tokenization; judged as commands of their own. */
const nestedBodies = new WeakMap()

/** Splits a shell command into segments of tokens. Quotes group; newline ; | & ( ) $( and ` split. */
/**
 * Parses the operator after a `<<` at `from` (`-`, spaces, then the delimiter,
 * which may be quoted or escaped — then the body is literal). Returns the
 * document and the index just past the delimiter.
 */
const parseHeredoc = (text, from) => {
  let j = from
  const strip = text[j] === "-"
  if (strip) {
    j += 1
  }
  while (j < text.length && (text[j] === " " || text[j] === "\t")) {
    j += 1
  }
  let delimiter = ""
  let quoted = false
  let inner = null
  for (; j < text.length; j++) {
    const d = text[j]
    if (inner !== null) {
      if (d === inner) {
        inner = null
      } else {
        delimiter += d
      }
    } else if (d === "'" || d === '"') {
      inner = d
      quoted = true
    } else if (d === "\\" && text[j + 1] === "\n") {
      j += 1
    } else if (d === "\\" && j + 1 < text.length) {
      delimiter += text[++j]
      quoted = true
    } else if (/[\s;|&<>()]/.test(d)) {
      break
    } else {
      delimiter += d
    }
  }
  return { delimiter, quoted, strip, end: j }
}

/** Reads the pending heredoc bodies starting at `from`; returns the bodies and the index after them. */
const readHeredocBodies = (text, from, pending) => {
  let j = from
  const bodies = []
  for (const doc of pending) {
    const lines = []
    while (j < text.length) {
      const eol = text.indexOf("\n", j)
      const line = text.slice(j, eol === -1 ? text.length : eol)
      j = eol === -1 ? text.length : eol + 1
      if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
        break
      }
      lines.push(line)
    }
    if (!doc.quoted) {
      bodies.push(lines.join("\n"))
    }
  }
  return { bodies, end: j }
}

/**
 * Index just past the `)` that closes a `$(` opened before `from`. The body is a
 * fresh shell context: quotes and escapes inside it are tracked, nested
 * parens counted. An unbalanced body runs to the end of the text.
 */
const substitutionEnd = (text, from) => {
  let depth = 1
  let quote = null
  // `case … in pattern) …;; esac`: a pattern's `)` closes nothing. Only the
  // keywords count — `case` or `esac` in command position, not as arguments.
  let cases = 0
  let word = ""
  let commandPosition = true
  let wordStart = true
  const endWord = () => {
    if (word.length > 0) {
      if (commandPosition && word === "case") {
        cases += 1
      } else if (commandPosition && word === "esac" && cases > 0) {
        cases -= 1
      }
      commandPosition = false
    }
    word = ""
  }
  const pending = []
  for (let j = from; j < text.length; j++) {
    const c = text[j]
    if (quote !== null) {
      if (c === quote) {
        quote = null
      } else if (c === "\\" && quote === '"') {
        j += 1
      }
      wordStart = false
      continue
    }
    if (c === "\\" && text[j + 1] === "\n") {
      j += 1
      continue
    }
    if (c === "<" && text[j + 1] === "<" && text[j + 2] !== "<") {
      endWord()
      const doc = parseHeredoc(text, j + 2)
      pending.push(doc)
      j = doc.end - 1
      wordStart = true
      continue
    }
    if (c === "\n" && pending.length > 0) {
      endWord()
      j = readHeredocBodies(text, j + 1, pending).end - 1
      pending.length = 0
      commandPosition = true
      wordStart = true
      continue
    }
    if (/[A-Za-z]/.test(c)) {
      word += c
      wordStart = false
      continue
    }
    endWord()
    if (c === "#" && wordStart) {
      // A comment inside the body runs to the end of its line.
      while (j + 1 < text.length && text[j + 1] !== "\n") {
        j += 1
      }
      continue
    }
    wordStart = /\s/.test(c) || ";|&(".includes(c)
    if (c === "\n") {
      commandPosition = true
      continue
    }
    if (/\s/.test(c)) {
      continue
    }
    if (";|&".includes(c)) {
      commandPosition = true
    } else if (c === "\\") {
      j += 1
      commandPosition = false
    } else if (c === "'" || c === '"') {
      quote = c
      commandPosition = false
    } else if (c === "(") {
      depth += 1
      commandPosition = true
    } else if (c === ")") {
      if (cases > 0 && depth === 1) {
        commandPosition = true
        continue
      }
      depth -= 1
      if (depth === 0) {
        return j + 1
      }
      commandPosition = true
    } else {
      commandPosition = false
    }
  }
  return text.length
}

/** Index just past the backtick that closes one opened before `from`. */
const backtickEnd = (text, from) => {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "\\") {
      j += 1
    } else if (text[j] === "`") {
      return j + 1
    }
  }
  return text.length
}

/** Masks a backslash-escaped `$` or backtick so it cannot open a substitution. */
const maskEscapes = (text) => {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[++i]
      if (next !== "\n") {
        out += next === "$" || next === "`" ? "\u0000" : `\\${next}`
      }
    } else {
      out += text[i]
    }
  }
  return out
}

/** Every `$(…)` and backtick body in one word — a word can carry several. */
const substitutionBodies = (word) => {
  const bodies = []
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "$" && word[i + 1] === "(") {
      const end = substitutionEnd(word, i + 2)
      bodies.push(word.slice(i + 2, word[end - 1] === ")" ? end - 1 : end))
      i = end - 1
    } else if (word[i] === "\\") {
      i += 1
    } else if (word[i] === "`") {
      const end = backtickEnd(word, i + 1)
      bodies.push(word.slice(i + 1, word[end - 1] === "`" ? end - 1 : end))
      i = end - 1
    }
  }
  return bodies
}

const tokenize = (command) => {
  const segments = []
  const ended = []
  let current = []
  let token = ""
  // The token as seen for substitution scanning: a quoted or escaped `$`
  // or backtick is literal text and cannot open `$(…)`, so it is masked.
  let scan = ""
  let hasToken = false
  let quote = null
  const scans = []
  let currentScans = []
  const SUBSTITUTION = new Set(["$", "`"])
  const endToken = () => {
    if (hasToken) {
      current.push(token)
      currentScans.push(scan)
    }
    token = ""
    scan = ""
    hasToken = false
  }
  const endSegment = (by = "") => {
    endToken()
    if (current.length > 0) {
      segments.push(current)
      scans.push(currentScans)
      ended.push(by)
    }
    current = []
    currentScans = []
  }
  // Heredocs: `<<'EOF'` bodies are literal and skipped; `<<EOF` bodies expand,
  // so their substitutions are judged. Bodies start after the next newline.
  const pending = []
  const heredocBodies = []
  const readHeredocs = (from) => {
    const read = readHeredocBodies(command, from, pending)
    heredocBodies.push(...read.bodies)
    pending.length = 0
    return read.end
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    // A backslash-newline is a line continuation: the shell deletes both.
    if (quote !== "'" && c === "\\" && command[i + 1] === "\n") {
      i += 1
      continue
    }
    if (quote === null && c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      endToken()
      const doc = parseHeredoc(command, i + 2)
      pending.push(doc)
      i = doc.end - 1
      continue
    }
    if (quote === null && c === "\n" && pending.length > 0) {
      endSegment(c)
      i = readHeredocs(i + 1) - 1
      continue
    }
    // A substitution is one unit of the word it sits in, quoted or not: its
    // body has its own quoting, so it is consumed whole and judged later.
    if (quote !== "'" && ((c === "$" && command[i + 1] === "(") || c === "`")) {
      const end = c === "`" ? backtickEnd(command, i + 1) : substitutionEnd(command, i + 2)
      const text = command.slice(i, end)
      token += text
      scan += text
      hasToken = true
      i = end - 1
      continue
    }
    if (quote !== null) {
      if (c === quote) {
        quote = null
      } else if (c === "\\" && quote === '"' && i + 1 < command.length) {
        // In double quotes a backslash escapes only $ ` " \ and newline;
        // before any other character the shell keeps both.
        const escaped = command[++i]
        if (SUBSTITUTION.has(escaped) || escaped === '"' || escaped === "\\" || escaped === "\n") {
          token += escaped
          scan += SUBSTITUTION.has(escaped) ? "\u0000" : escaped
        } else {
          token += `\\${escaped}`
          scan += `\\${escaped}`
        }
      } else {
        token += c
        scan += quote === "'" && SUBSTITUTION.has(c) ? "\u0000" : c
      }
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      hasToken = true
      continue
    }
    if (c === "#" && !hasToken) {
      // A comment runs to the end of the line; the shell never runs it.
      while (i + 1 < command.length && command[i + 1] !== "\n") {
        i += 1
      }
      continue
    }
    if (c === "\\" && i + 1 < command.length) {
      const escaped = command[++i]
      token += escaped
      scan += SUBSTITUTION.has(escaped) ? "\u0000" : escaped
      hasToken = true
      continue
    }
    if (c === "|" && command[i + 1] === "|") {
      endSegment("||")
      i += 1
      continue
    }
    if (c === "\n" || ";|&()".includes(c)) {
      endSegment(c)
      continue
    }
    if (/\s/.test(c)) {
      endToken()
      continue
    }
    token += c
    scan += c
    hasToken = true
  }
  endSegment()
  if (pending.length > 0) {
    readHeredocs(command.length)
  }
  joiners.set(segments, ended)
  // A word can carry substitutions ("$(…)" or backticks), and so can an
  // unquoted heredoc body: every body is a command judged on its own.
  const bodies = []
  for (const words of scans) {
    for (const word of words) {
      bodies.push(...substitutionBodies(word))
    }
  }
  for (const body of heredocBodies) {
    bodies.push(...substitutionBodies(maskEscapes(body)))
  }
  nestedBodies.set(segments, bodies)
  return segments
}

/** True when segment `index` was followed by a pipe (not `;`, `&&`, or a newline). */
const pipedInto = (segments, index) => (joiners.get(segments) ?? [])[index] === "|"

const WRAPPERS = new Set("env sudo command exec time nice nohup builtin xargs corepack".split(" "))
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
/** Per wrapper, the options that consume the next token (xargs -I {}, sudo -u name, env -u NAME). */
const WRAPPER_VALUED = {
  sudo: new Set(
    "-u -g -h -p -C -r -U -D -T -a -R -c --user --group --host --prompt --close-from --role --other-user --chdir --command-timeout --type --chroot --login-class --auth-type".split(
      " ",
    ),
  ),
  env: new Set("-u -S -C -P --unset --split-string --chdir".split(" ")),
  xargs: new Set(
    "-I -J -n -P -L -d -s -E -a --replace --max-args --max-procs --max-lines --delimiter --max-chars --eof --arg-file".split(
      " ",
    ),
  ),
  nice: new Set("-n --adjustment".split(" ")),
  time: new Set("-f -o --format --output".split(" ")),
  exec: new Set(["-a"]),
}
/** `sudo -nu root`, `xargs -0n 1`: in a cluster, the last letter may take the value. */
const takesValue = (wrapper, option) => {
  const valued = WRAPPER_VALUED[wrapper]
  if (valued === undefined) {
    return false
  }
  if (option.startsWith("--") || option.length <= 2) {
    return valued.has(option)
  }
  // `-R/tmp`: a valued first letter carries its value inline; nothing follows.
  if (valued.has(`-${option[1]}`)) {
    return false
  }
  return valued.has(`-${option.at(-1)}`)
}
/** Shell keywords that may precede the command word in a compound command. */
const KEYWORDS = new Set("if then else elif while until do ! {".split(" "))
/** Package-manager global options that may precede exec/x/dlx. */
const PM_VALUED = new Set("-C --prefix --registry --loglevel --filter -F -w --workspace".split(" "))

/** Index of the command word after any VAR=value prefixes and wrappers (with their options). */
const afterPrefixes = (tokens) => {
  let i = 0
  while (i < tokens.length) {
    if (tokens[i] === "function") {
      i += 2
    } else if (KEYWORDS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      i += 1
    } else if (WRAPPERS.has(basename(tokens[i]))) {
      const wrapper = basename(tokens[i])
      i += 1
      if (wrapper === "command" && (tokens[i] === "-v" || tokens[i] === "-V")) {
        // `command -v name` only looks a command up; nothing runs.
        return tokens.length
      }
      while (i < tokens.length && tokens[i].startsWith("-")) {
        i += takesValue(wrapper, tokens[i]) ? 2 : 1
      }
    } else {
      break
    }
  }
  return i
}

/** Expands `sh -c "…"` and `eval …` bodies and strips wrappers and VAR=value prefixes. */
const normalize = (segments) => {
  const out = []
  const visit = (tokens, depth) => {
    if (depth > NESTING_LIMIT) {
      denyNesting()
    }
    let i = 0
    while (i < tokens.length) {
      const word = tokens[i]
      if (word === "function") {
        i += 2
      } else if (KEYWORDS.has(word)) {
        i++
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        out.push(["<assign>", word])
        i++
      } else if (WRAPPERS.has(basename(word))) {
        // Skip the wrapper and its own options (env -i, xargs -0, sudo -u name).
        const wrapper = basename(word)
        i++
        if (wrapper === "command" && (tokens[i] === "-v" || tokens[i] === "-V")) {
          return
        }
        while (i < tokens.length && tokens[i].startsWith("-")) {
          i += takesValue(wrapper, tokens[i]) ? 2 : 1
        }
      } else {
        break
      }
    }
    const rest = tokens.slice(i)
    if (rest.length === 0) {
      return
    }
    const head = basename(rest[0])
    if (SHELLS.has(head)) {
      // -c may be clustered: bash -lc "…", sh -xc "…".
      const at = rest.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
      if (at !== -1 && rest[at + 1] !== undefined) {
        for (const inner of tokenize(rest[at + 1])) {
          visit(inner, depth + 1)
        }
        return
      }
    }
    if (head === "eval") {
      for (const inner of tokenize(rest.slice(1).join(" "))) {
        visit(inner, depth + 1)
      }
      return
    }
    if (head === "export") {
      for (const assignment of rest.slice(1)) {
        out.push(["<assign>", assignment])
      }
      return
    }
    out.push([head, ...rest.slice(1)])
  }
  for (const segment of segments) {
    visit(segment, 0)
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
  if (recursive && targets.length === 0) {
    // `rm -rf $(pwd)`: the substitution became its own segment, leaving no target to judge.
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
        const segments = normalize(tokenize(body))
        judgeSegments(segments)
        for (const [head] of segments) {
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

const NESTING_LIMIT = 4
const denyNesting = () =>
  deny(
    `the command nests more than ${NESTING_LIMIT} levels of substitutions or shell bodies`,
    "flatten it: run the inner commands as their own steps",
  )

const judgeCommand = (command, depth = 0) => {
  if (depth > NESTING_LIMIT) {
    denyNesting()
  }
  const raw = tokenize(command)
  // Nested command bodies — `$(…)`, backticks, `sh -c '…'`, `eval …` — are
  // commands of their own, pipelines included.
  for (const body of nestedBodies.get(raw) ?? []) {
    judgeCommand(body, depth + 1)
  }
  for (const segment of raw) {
    // `env -S "git push -f"` splits its string into a command of its own.
    for (let at = 0; at < segment.length; at++) {
      if (basename(segment[at]) === "env") {
        const split = segment.findIndex(
          (arg, index) => index > at && (arg === "-S" || arg === "--split-string"),
        )
        if (split !== -1 && segment[split + 1] !== undefined) {
          judgeCommand(segment[split + 1], depth + 1)
        }
        break
      }
    }
    const rest = segment.slice(afterPrefixes(segment))
    const head = basename(rest[0] ?? "")
    if (SHELLS.has(head)) {
      const at = rest.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
      if (at !== -1 && rest[at + 1] !== undefined) {
        judgeCommand(rest[at + 1], depth + 1)
      }
    } else if (head === "eval") {
      judgeCommand(rest.slice(1).join(" "), depth + 1)
    }
  }
  // `find … | xargs rm`: the delete sits in the segment a pipe leads to.
  raw.forEach((segment, index) => {
    const [head, ...args] = segment
    if (basename(head) !== "find" || !args.some((arg) => PROTECTED_NAME.test(arg))) {
      return
    }
    const downstream = raw[index + 1] === undefined ? [] : normalize([raw[index + 1]])
    if (pipedInto(raw, index) && downstream.some(([h]) => basename(h) === "rm")) {
      deny("a find over .git or the lockfile piped into rm", "use git and npm to manage those")
    }
  })
  // Everything else (including sh -c bodies) is judged on the normalized segments.
  judgeSegments(normalize(raw))
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
