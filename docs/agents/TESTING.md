# Testing

Three suites, three purposes. All run in the profiles; none may be skipped to get green.

## Unit (`test/unit/`) — logic through fake layers

Handlers take services, so tests provide in-memory layers and run plan/apply as plain Effects — no filesystem, no CLI process. See `test/unit/task-create.test.ts` for the pattern (`Layer.succeed(Store, Store.of({ … }))`). Property-based tests (fast-check) guard parsing and token stability.

## Contract invariants (`test/contract/`) — mechanical protocol rejection

`invariants.test.ts` runs every registered contract against the protocol rules (reserved params, error codes, examples, schema generation, roster/registry sync). When you add a command, these tests are the spec. Add new invariants here when a convention matters enough to enforce.

## E2E (`test/e2e/`) — the shipped artifact, black-box

Runs `dist/bin.cjs` with execa in a temp cwd, asserting on stdout/stderr/exit codes — the artifact consumers get, not the source. Runs in the Push profile after the build. When you add a command, add one happy-path e2e case and one failure case asserting the envelope `code` and exit.

Conventions:

- Assert stdout purity: machine modes emit exactly one envelope line (or NDJSON events), nothing else.
- Never assert on timing, absolute paths, or ANSI — normalize first.
- Each test gets a fresh temp cwd; never depend on test order.

## The Starter Contract (`scripts/starter-contract.mjs`)

The template's own guarantee, run in CI: fresh `git archive` → install → hooks → build → protocol checks → generator round-trip → pack hygiene. If you change setup, hooks, packaging, or the protocol, run `npm run test:contract` locally (needs committed changes — it archives HEAD).
