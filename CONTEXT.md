# Lasso Starter Context

Lasso is a starter kit for CLIs whose primary user is an AI agent — the agent that edits this repository and the agent that runs the installed binary. Its domain is the contract system that generates every surface of the CLI from one definition and verifies each surface mechanically.

## Language

**CommandContract**:
The single declaration of a command: name, params, schemas, error codes, examples, capabilities, handler. The parser, help, `describe`, JSON Schema, and docs are generated from it or validated against it.
_Avoid_: command definition, command config

**Output Protocol**:
The frozen machine surface: envelopes with `schemaVersion`, the exit-code registry, NDJSON events, and the confirmation flow. Changes are additive only.
_Avoid_: output format, JSON mode

**Plan/Apply Split**:
The shape of every mutation. `plan` derives intent without side effects; `apply` executes exactly one confirmed plan and never sees the input. Plans are deterministic for identical state and input, so apply-assigned metadata stays out of them.
_Avoid_: two-phase commit, preview mode

**Capability Split**:
The service sets by contract role: queries and plans get read services, applies get write services. A handler that asks for the wrong capability does not compile.
_Avoid_: permissions, access control

**Confirmation Token**:
The hash that binds `{command, schemaVersion, plan}` to a confirmation. A changed plan invalidates the token, so an agent can never apply a plan it did not preview.
_Avoid_: nonce, session token

**Verification Profile**:
A named depth of checking. Fast is format, lint, types, Effect diagnostics, and unit tests. Push adds build, dead code, e2e, and pack smoke. CI adds coverage and the Starter Contract. Each contains the previous, and local and CI run identical commands.
_Avoid_: test suite, pipeline

**Starter Contract**:
The self-test that proves a fresh archive of the template delivers every advertised guarantee: install, hooks, build, protocol behavior, generator round-trip, rename journey, pack hygiene.
_Avoid_: smoke test, template test

**Renderer Monopoly**:
Only the Renderer writes stdout; diagnostics go to stderr. Lint enforces it and e2e asserts it.
_Avoid_: output helper, print function

## Relationships

- The **CommandContract** generates the surfaces; the **Output Protocol** constrains what they emit.
- The **Plan/Apply Split** and the **Confirmation Token** make mutations previewable and replay-safe; the **Capability Split** makes the plan side read-only at compile time.
- The **Verification Profiles** check the contracts; the **Starter Contract** checks the template itself.

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
> Domain expert: "It runs `describe --json`. If that answer could drift from the parser, the contract-invariant tests in the Fast Profile would fail."
