# Claude Code hooks

The hooks in `.claude/hooks/` are registered in `.claude/settings.json`. They provide feedback and catch common mistakes. They do not enforce a security boundary. Lint, tests, git hooks, and CI run independently of the agent harness. The guarantees that no spelling gets around live on the server: protect `main` against force pushes and deletion, and require the `ci` check before merging.

## Direct-command checks

`guard.mjs` checks one literal command with optional leading environment assignments. Quotes can group arguments. The checks cover:

- Git hook bypass flags, disabling `LEFTHOOK` assignments, and changes to `core.hooksPath`.
- Force pushes with no named destination, a symbolic source, or a destination of main/master; deletion of main/master.
- Direct `npx`, `bunx`, or package-manager `exec`/`dlx` invocations of pinned tools. Use the repository's npm scripts instead.
- Direct `rm` of git metadata, the lockfile, or the repository root.

`guard.mjs` exports `judge(payload)`, the decision itself, which the tests call in-process; run as the hook, it reads the payload from stdin. The hook leaves shell programs alone, including pipelines, multiple commands, substitutions, heredocs, wrappers, and `sh -c` bodies. It does not expand variables, follow aliases, or resolve symlinks. These limits keep the check small and prevent literal script text from being mistaken for commands.

Edit/Write checks protect `dist/`, `coverage/`, `node_modules/`, `.git/`, `.lasso/`, the lockfile, the command snapshot, and the generated guide catalog. A refusal exits 2 and provides a `fix:` line.

Edits to the files that configure the checks (`.oxlintrc.json`, `biome.json`, `tsconfig.json`, `vitest.config.ts`, `knip.json`, `lefthook.yml`, `commitlint.config.mjs`, `scripts/verify.mjs`, `.claude/`, and `.github/workflows/`) are allowed but not silent: the guard answers `permissionDecision: "ask"`, so a person approves each one. Loosening a rule, threshold, or hook to turn a check green is the failure this catches; tightening one is a quick approval.

## Permissions

`.claude/settings.json` allows the sanctioned inner loop without prompts: the verification profiles and their steps, the doctor, the generators, `npm run surface:update`, and a single Vitest file. `npm run dev` is not on the list, because a replaced demo can reach real services. Deny rules keep `.env` and `.env.*` out of an agent's context.

## Feedback hooks

- `session-start.mjs` runs the doctor and prints failures, or one healthy line. It never blocks.
- `post-edit.mjs` formats edited TypeScript, JavaScript, and JSON files and lints scripts. Effect diagnostics run as part of lint. Set `LASSO_POST_EDIT_FULL=1` to also run project typechecking after TypeScript edits. `npm run check` always runs both lint and typechecking. An edit to `guides/topics/*.md` regenerates the guide catalog at once: invalid frontmatter or an oversized body is reported at the edit, and `additionalContext` reminds the agent to record the surface change.
- `stop-check.mjs` runs `npm run check` on a dirty tree. A failure returns the diagnostics; `stop_hook_active` prevents a loop.

Post-edit failures report problems after the edit; they do not undo it. A missing toolchain reports `npm ci`. The default post-edit budget is 15 seconds for formatting plus 30 for lint; optional typechecking brings it to 90 seconds within the 120-second hook timeout.

All hooks resolve their repository from their script location, or use the payload's `cwd` when it identifies another Lasso worktree. Run `npm run check` after addressing feedback.
