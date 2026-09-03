# Claude Code guards

The hooks in `.claude/hooks/` are registered in `.claude/settings.json`. They keep an agent inside the repository's gates while it works. They are a speed bump for an agent that would otherwise take the shortcut, not a sandbox: a determined bypass is always possible, and the git hooks and CI remain the real gates.

| Event | Script | Matcher | Effect of a nonzero exit |
|---|---|---|---|
| SessionStart | `session-start.mjs` | — | Never blocks; prints the doctor's failing checks (or one healthy line) so a missing install or unpatched lint is visible before the first edit. |
| PreToolUse | `guard.mjs` | `Bash\|Edit\|Write` | Exit 2 refuses the tool call; stderr carries the reason and the compliant path. |
| PostToolUse | `post-edit.mjs` | `Edit\|Write` | Exit 2 reports diagnostics to the agent. The edit has already landed; it is not undone. |
| Stop | `stop-check.mjs` | — | Exit 2 refuses to end the turn while `npm run check` is red on a dirty tree; stderr carries the failing step. `stop_hook_active` prevents loops. |

## What the guard refuses

Commands are split into argv segments and judged by argv: quotes group text; newlines, `;`, `|`, `&`, and parentheses split; `#` comments and backslash-newlines vanish; `env`, `sudo`, `xargs` and similar wrappers, `VAR=value` prefixes, and leading keywords (`if`, `while`, `do`) are stripped. A `$(…)` or backtick body, an `sh -c` or `eval` body, and an unquoted heredoc body are judged as commands of their own; a quoted heredoc (`<<'EOF'`) is literal and skipped so writing a file never trips a rule. The splitter is a sketch of the shell, not a shell: it is there to catch an agent's honest command, and the git hooks and CI remain the real gates. The rules are a table in `guard.mjs` and `test/unit/guard.test.ts` runs every row below.

- `git commit` with `--no-verify` or `-n`; `git merge`/`git rebase --no-verify`; `git push --no-verify`.
- `LEFTHOOK=0`, `LEFTHOOK_SKIP`, `LEFTHOOK_EXCLUDE` in any position, including `env` and `export`.
- `git config core.hooksPath …`, `git -c core.hooksPath=…`, `git --config-env=core.hooksPath=…`.
- Force-pushes (`-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `+ref`) with no named ref, a symbolic source (`HEAD`, `@`), or a destination of `main`/`master`; deletion of main via `:main` or `--delete`.
- `npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx` whose executable, or `--package`/`-p` value, is a pinned tool or its package, at any version suffix.
- `rm` of `.git`, anything inside it, `package-lock.json`, `package*` globs, a recursive `rm` of the repository root or with no literal target (`rm -rf $(pwd)`); `find … -exec rm`/`-delete`/`| xargs rm` aimed at `.git` or the lockfile.
- Edit or Write to `dist/`, `coverage/`, `node_modules/`, `.git/`, `.lasso/`, `package-lock.json`, `test/contract/surface.snapshot.json`, or `src/guides/catalog.generated.ts`, with symlinks (including dangling ones) resolved first.

Legitimate forms pass: `git push -n` (dry run), `git config --get core.hooksPath`, `git push origin feature -f`, a commit message that mentions `--no-verify`, `rm -rf dist`, `npx skills …`.

Known limits, by design: the guard does not track `cd`, expand shell variables or globs (`rm -rf "$dir"` is allowed; a lockfile-shaped glob is not), follow git aliases, or resolve every wrapper option. A forced push of a symbolic source (`HEAD`, `@`) is refused because its destination may be main. The git hooks and CI remain the real gates.

## What the post-edit hook runs

| File | biome format | oxlint (type-aware) | tsc (project) | effect-tsgo diagnostics (file) |
|---|---|---|---|---|
| `.ts` | yes | yes | yes | yes |
| `.mjs`, `.cjs` | yes | yes | — | — |
| `.json` | yes | — | — | — |
| `.md`, `.yml`, other | — | — | — | — |

Budget: 15 s + 30 s + 45 s + 25 s, inside the 120 s hook timeout. Any failure, including a timeout or a tool that fails to start, is reported; a clean `.ts` edit costs about two seconds. A missing or partial `node_modules` reports `run: npm ci`.

## Roots and worktrees

All four hooks derive the repository root from their own location. When the hook payload's `cwd` is itself a Lasso workspace (a Claude-managed worktree), they judge paths and run tools against that workspace instead.

## Recovery

- Guard refused a command: read the `fix:` line; the compliant path is always available (run the gate, push a branch, use the npm script).
- Post-edit reported errors: fix the named file, then `npm run check`.
- Stop refused: run `npm run check`, fix the failing step, then finish.
- Doctor reported a problem at session start: run the `fix` it prints; `npm ci` and `npm run setup` cover the common ones.
