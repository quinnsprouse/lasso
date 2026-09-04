# Testing

Three suites, three purposes, at three depths: unit and contract tests run in Fast; e2e joins in Push; coverage and the Starter Contract join in CI. None may be skipped to get green — `scripts/test-hygiene.mjs` fails the Fast profile on any `.skip`, `.only`, `.todo`, or focused form.

## Unit (`test/unit/`) — logic through fake layers

Handlers take services, so tests provide in-memory layers and run plan/apply as plain Effects — no filesystem, no CLI process. See `test/unit/task-create.test.ts` for the pattern (`Layer.succeed(StoreReader, StoreReader.of({ … }))`). Property-based tests (fast-check) pin confirmation-token stability under arbitrary plan shapes; `test/unit/store.test.ts` runs the real filesystem store in a temp directory.

## Contract invariants (`test/contract/`) — mechanical protocol rejection

- `invariants.test.ts` checks contract declarations, error codes, schema generation, and plan determinism.
- `compatibility.test.ts` requires the recorded `describe` and `schema` definitions to match. Run `npm run surface:update` and review the diff for compatibility.
- `runtime.test.ts` exercises the parser, mutation flow, rendering, and stdout purity through fake services. `commands.test.ts` exercises the demo commands.
- `type-fixtures.ts` checks invalid parameters and service boundaries at compile time.
- `guides.test.ts` and `skill.test.ts` check references to real commands and topics. Writing style and length are authoring choices.
- `test/unit/guide-generator.test.ts` verifies empty catalogs and standalone workflow topics.
- `test/unit/guard.test.ts` checks direct-command refusals and the shell syntax the hook leaves alone.

## E2E (`test/e2e/`) — the shipped artifact, black-box

Runs `dist/bin.cjs` with execa in a temp cwd, asserting on stdout/stderr/exit codes — the artifact consumers get, not the source. Runs in the Push profile after the build. When you add a command, add one happy-path e2e case and one failure case asserting the envelope `code` and exit.

Conventions:

- Assert stdout purity: machine modes emit exactly one envelope line (or NDJSON events), nothing else.
- Never assert on timing, absolute paths, or ANSI — normalize first. (The Starter Contract's 5 s bound on a missing-argument failure is the one wall-clock check; it proves nothing waited on stdin.)
- Each e2e and real-store test gets a fresh temp cwd; never depend on test order.

## The Starter Contract (`scripts/starter-contract.mjs`)

The template's own guarantee, run in CI: fresh `git archive` → install → hooks → doctor → build → protocol checks → guidance journey → generator scaffold → rename journey → pack hygiene. Run it with `npm run test:starter`. If you change setup, hooks, packaging, or the protocol, commit the changes and run `npm run test:starter` locally; it archives HEAD.
