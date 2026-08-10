# Lasso Starter Context

Lasso is a starter kit for CLIs whose primary user is an AI agent — both the agent building inside the repository and the agent invoking the shipped binary. Its domain is the contract system that keeps every surface of the CLI generated from one definition and mechanically verified.

## Language

**CommandContract**:
The single declaration of a command — name, params, schemas, error codes, examples, capabilities, handler. Every other surface (parser, help, describe, JSON Schema, docs) is generated from or validated against it.
_Avoid_: command definition, command config

**Output Protocol**:
The frozen machine surface: envelopes with `schemaVersion`, the exit-code registry, NDJSON events, and the confirmation flow. Changes are additive only.
_Avoid_: output format, JSON mode

**Plan/Apply Split**:
The structural shape of every mutation: `plan` derives intent without side effects, `apply` executes exactly one confirmed plan. The runtime owns `--dry-run`, `--confirm`, and `--yes`.
_Avoid_: two-phase commit, preview mode

**Confirmation Token**:
The hash binding a plan to its confirmation. A changed plan invalidates the token, so an agent can never apply a plan it did not preview.
_Avoid_: nonce, session token

**Verification Profile**:
A named depth of checking. Fast (format, lint, types, Effect diagnostics, unit tests), Push (Fast + build, dead code, e2e, pack smoke), CI (Push + coverage, Starter Contract). Each contains the previous; local and CI run identical commands.
_Avoid_: test suite, pipeline

**Starter Contract**:
The self-test proving a fresh archive of the template delivers every advertised guarantee: install, hooks, build, protocol behavior, generator workflow, pack hygiene.
_Avoid_: smoke test, template test

**Renderer Monopoly**:
Only the Renderer service writes stdout. Diagnostics go to stderr. Enforced by lint and asserted in e2e.
_Avoid_: output helper, print function

## Relationships

- The **CommandContract** generates the surfaces; the **Output Protocol** constrains what they emit.
- The **Plan/Apply Split** and **Confirmation Token** together make mutations previewable and replay-safe.
- The **Verification Profiles** check the contracts; the **Starter Contract** checks the template itself.

## Example dialogue

> Developer: "I added a delete command but skipped the plan step — it's just one line."
>
> Domain expert: "It won't compile: a mutation contract requires `plan` and `apply`. The runtime owns `--dry-run` and confirmation, so the shape isn't optional."
>
> Developer: "How does an agent know the flag names without reading the source?"
>
> Domain expert: "It runs `describe --json`. If that answer could drift from the parser, the contract-invariant tests in the Fast profile would have failed."
