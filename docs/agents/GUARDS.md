# Claude Code hooks

The hooks in `.claude/hooks/` are registered in `.claude/settings.json`. They provide feedback and catch common mistakes. They do not enforce a security boundary. Lint, tests, git hooks, and CI run independently of the agent harness.

## Direct-command checks

`guard.mjs` checks one literal command with optional leading environment assignments. Quotes can group arguments. The checks cover:

- Git hook bypass flags, disabling `LEFTHOOK` assignments, and changes to `core.hooksPath`.
- Force pushes with no named destination, a symbolic source, or a destination of main/master; deletion of main/master.
- Direct `npx`, `bunx`, or package-manager `exec`/`dlx` invocations of pinned tools. Use the repository's npm scripts instead.
- Direct `rm` of git metadata, the lockfile, or the repository root.

The hook leaves shell programs alone, including pipelines, multiple commands, substitutions, heredocs, wrappers, and `sh -c` bodies. It does not expand variables, follow aliases, or resolve symlinks. These limits keep the check small and prevent literal script text from being mistaken for commands.

Edit/Write checks protect `dist/`, `coverage/`, `node_modules/`, `.git/`, `.lasso/`, the lockfile, the command snapshot, and the generated guide catalog. A refusal exits 2 and provides a `fix:` line.

## Feedback hooks

- `session-start.mjs` runs the doctor and prints failures, or one healthy line. It never blocks.
- `post-edit.mjs` formats edited TypeScript, JavaScript, and JSON files and lints scripts. Effect diagnostics run as part of lint. Set `LASSO_POST_EDIT_FULL=1` to also run project typechecking after TypeScript edits. `npm run check` always runs both lint and typechecking.
- `stop-check.mjs` runs `npm run check` on a dirty tree. A failure returns the diagnostics; `stop_hook_active` prevents a loop.

Post-edit failures report problems after the edit; they do not undo it. A missing toolchain reports `npm ci`. The default post-edit budget is 15 seconds for formatting plus 30 for lint; optional typechecking brings it to 90 seconds within the 120-second hook timeout.

All hooks resolve their repository from their script location, or use the payload's `cwd` when it identifies another Lasso worktree. Run `npm run check` after addressing feedback.
