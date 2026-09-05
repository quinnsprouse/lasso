# How Lasso fits together

Lasso is a starter kit for CLIs used by agents. It also supplies instructions and checks for agents editing the repository.

## Commands and execution

A `CommandContract` declares a command's parameters, schemas, errors, examples, and implementation. `defineQuery` accepts a handler. `defineMutation` requires a plan and an apply function.

`surfaceOf` adds the framework flags and normalizes parameter names. The parser adapter, `describe`, and `schema` use that definition. Execution and guidance validation use the same Effect CLI parser; validation substitutes inert handlers so it cannot execute domain code.

Queries and plans declare read services. Apply functions declare write services. The command roster checks those requirements when registering a command. Service wiring belongs to the application and changes when replacing the demo.

A mutation plan contains the intent that will be confirmed. The runtime encodes it, hashes the command name, schema version, and plan, then compares that hash when the agent replays `confirmArgs`. Apply receives the decoded plan. It receives no original flags. Timestamps assigned during a write belong in apply so they do not change confirmation tokens.

## Output and guidance

`renderOutcome` defines the JSON envelopes, NDJSON terminal events, and text output. The Renderer uses it for command results and machine-mode `--version`. The entrypoint uses it for settled failures. Diagnostics go to stderr in machine formats.

Expected errors include a code and a recovery instruction in `fix`. Optional `next` entries contain argument arrays for this CLI. The runtime checks those arguments without executing their commands.

`describe` and `schema` provide generated reference material. Authored guide topics explain workflows or domain rules that those definitions cannot express. The shipped skill at `skills/<bin>/SKILL.md` tells an agent how to discover commands and follow confirmation requests.

## Checks

`scripts/verify.mjs` defines three verification profiles:

- Fast checks formatting, lint, types, generated guides, and unit and contract tests.
- Push adds the build, dead-code analysis, e2e tests, and package smoke test.
- CI adds coverage and a fresh-template test from an archive of HEAD.

The command snapshot records `describe` and `schema` output. Updating it makes changes visible for compatibility review; it does not decide whether a change is safe.

Mutation fixtures supply domain-specific inputs, expected results, and read-service layers. A shared assertion checks deterministic plans under different clocks and a JSON round trip. Each registered mutation must have a successful fixture.

Claude Code hooks provide editing feedback and catch common direct-command mistakes. They do not interpret arbitrary shell programs. Lint, tests, Git hooks, and CI work independently of those hooks.
