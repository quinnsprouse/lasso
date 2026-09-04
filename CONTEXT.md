# Lasso Starter Context

Lasso is a starter kit for CLIs whose primary user is an AI agent — the agent that edits this repository and the agent that runs the installed binary. Its domain is the contract system that generates every surface of the CLI from one definition and verifies each surface mechanically.

## Language

**CommandContract**:
The single declaration of a command: name, params, schemas, error codes, examples, handler. Capabilities derive from its kind. The parser, help, `describe`, JSON Schema, and the Surface Snapshot are generated from it or validated against it.
_Avoid_: command definition, command config

**Output Protocol**:
The machine output contract: versioned envelopes, exit codes, NDJSON events, and confirmation flow. Published changes need compatibility review.
_Avoid_: output format, JSON mode

**Surface Snapshot**:
The recorded `describe` and `schema` payloads in `test/contract/surface.snapshot.json`. Tests fail on any unrecorded change. Run `npm run surface:update`, then review the diff for compatibility; the tool does not classify changes.
_Avoid_: golden file, fixture

**Plan/Apply Split**:
The shape of every mutation. `plan` derives intent without side effects; the runtime encodes it through `planSchema`, previews and hashes that encoding, and `apply` executes exactly one confirmed plan — its decoded form — and never sees the input. Plans are deterministic for identical state and input, so apply-assigned metadata stays out of them.
_Avoid_: two-phase commit, preview mode

**Capability Split**:
The service sets by contract role: queries and plans get read services, applies get write services. A handler that asks for the wrong capability does not compile.
_Avoid_: permissions, access control

**Confirmation Token**:
The hash that binds `{command, schemaVersion, plan}` to a confirmation. A changed plan invalidates the token, so a `--confirm` replay can never apply a plan that differs from the one previewed. `--yes` is the explicit opt-out of previewing.
_Avoid_: nonce, session token

**Verification Profile**:
A named depth of checking. Fast is format, lint, types, Effect diagnostics, test hygiene, guide-catalog freshness, and the unit and contract tests. Push adds build, dead code, e2e, and pack smoke. CI adds coverage and the Starter Contract. Each contains the previous. One definition in `scripts/verify.mjs` drives all three: the pre-push hook runs Push, CI runs CI, so a green Push locally means the same steps pass in CI.
_Avoid_: test suite, pipeline

**Starter Contract**:
The self-test that proves a fresh archive of the template delivers every advertised guarantee: install, hooks, doctor, build, protocol behavior, the guidance journey, generator scaffold, rename journey, pack hygiene.
_Avoid_: smoke test, template test

**Point-of-use Guidance**:
Every terminal outcome carries `next` (executable next moves as argv, validated against the surface) and `guides` (topic ids); error outcomes also carry the required `fix` sentence. Point-of-use guidance outranks documents: an error with a complete fix declares no topics of its own (it still inherits its command's).
_Avoid_: hints, tips, suggestions

**Guide Topic**:
An authored Markdown model in `guides/topics/`, served by the binary through `guide get`, for knowledge the command surface cannot express. Admitted only when an agent mid-task would fetch it to build a model. Declared by the contracts that need it; inlined into the committed `src/guides/catalog.generated.ts` by `node scripts/guides.mjs`, so the bundle carries exactly the topics its version was built with.
_Avoid_: doc, help page, skill reference

**Shipped Skill**:
`skills/<bin>/SKILL.md`, the guidance in an agent's context before its first command: the safety contract and a concise router of intents to first moves and guide topics.
_Avoid_: prompt, system instructions

**Output Authority**:
`renderOutcome` defines every application outcome write in every format. The Renderer emits it inside Effect and `src/bin.ts` writes it at the process boundary. In machine formats the parser adapter's shim passes exactly one parser line (`--version`, in the negotiated format) to stdout and routes every other console write to stderr; text-mode parser help and version output stay parser-owned. Lint bans `Console`, `process`, and `console` in `src/` outside those process-boundary files; the runtime and e2e tests assert machine-mode stdout purity.
_Avoid_: renderer monopoly, output helper, print function

**Agent Guards**:
The Claude Code hooks in `.claude/hooks/`: the guard refuses the common actions that bypass the gates before a Bash, Edit, or Write call; the post-edit hook reports file-type-dependent format, lint, type, and Effect diagnostics after an Edit or Write; the session-start hook prints the doctor's failing checks; the stop hook refuses to end a turn on a red tree. A speed bump for an agent, not a sandbox.
_Avoid_: linter, pre-commit

## Relationships

- The **CommandContract** generates the surfaces; the **Output Protocol** constrains what they emit.
- The **Plan/Apply Split** and the **Confirmation Token** make mutations previewable and replay-safe; the **Capability Split** makes the plan side read-only at compile time.
- **Point-of-use Guidance** answers a missing value at the moment it matters; a **Guide Topic** answers a missing model when the outcome names it; the **Shipped Skill** routes an intent to the right topic before the first command.
- The **Verification Profiles** check the contracts; the **Surface Snapshot** checks the protocol's history; the **Starter Contract** checks the template itself; the **Agent Guards** keep an agent inside all three while it edits.

## Example dialogue

> Developer: "I added a delete command but skipped the plan step — it's just one line."
>
> Domain expert: "It won't compile. A mutation contract requires `plan` and `apply`, and the runtime owns `--dry-run` and confirmation, so the shape is not optional."
>
> Developer: "Can the plan write the record directly and skip apply?"
>
> Domain expert: "No — plans get read services only. Writing from a plan fails the type check, not a code review."
>
> Developer: "How does an agent learn the flag names without reading the source?"
>
> Domain expert: "It runs `describe --json`. The parser and `describe` are both generated from the same CommandSurface, so they cannot disagree, and the runtime tests drive the real parser to prove it."
