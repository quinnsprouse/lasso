# Testing

Three suites, three purposes, at three depths: unit and contract tests run in Fast; e2e joins in Push; coverage and the Starter Contract join in CI. None may be skipped to get green — `scripts/test-hygiene.mjs` fails the Fast profile on any `.skip`, `.only`, `.todo`, or focused form.

## Unit (`test/unit/`) — logic through fake layers

Handlers take services, so tests provide in-memory layers and run plan/apply as plain Effects — no filesystem, no CLI process. See `test/unit/task-create.test.ts` for the pattern (`Layer.succeed(StoreReader, StoreReader.of({ … }))`). Property-based tests (fast-check) pin confirmation-token stability under arbitrary plan shapes; `test/unit/store.test.ts` runs the real filesystem store in a temp directory.

## Contract invariants (`test/contract/`) — mechanical protocol rejection

`invariants.test.ts` runs every registered contract against the protocol rules (reserved CLI names, error codes, examples, standalone schema generation, the error-catalog table, the frozen exit registry, and plan determinism: every mutation is planned twice against identical fake state); `compatibility.test.ts` compares the current `describe` and `schema` payloads with `surface.snapshot.json` through the comparator in `surface-diff.ts` and fails when it reports a breaking change (removed or changed protocol, newly required or newly constrained inputs, weakened or widened outputs) or an unrecorded addition; `npm run surface:update` shares that comparator and refuses breaking changes unless `--allow-breaking` is passed after review; a genuine break also bumps `schemaVersion`); `runtime.test.ts` drives the real parser + adapter + renderer in-process through test layers (the harness is `harness.ts`), proving the mutation state machine, every stream shape, and stdout purity against a handler that logs; `commands.test.ts` runs the shipped roster through the same harness, so every command's handler, text rendering, and guidance is covered without the binary (coverage counts in-process runs only, never e2e); `type-fixtures.ts` proves invalid params, unwired services, and capability-split violations fail `tsc`; `guides.test.ts` checks every guide topic (honest metadata, every fenced command parses, every declared topic exists, no flag lists) and `skill.test.ts` checks the shipped skill (size budget, portable frontmatter, every command and topic it names is real); `test/unit/invocation.test.ts` pins the shared invocation validator against the real parser; `test/unit/guard.test.ts` runs the guard hook over the table in GUARDS.md. When you add a command, these tests are the spec. Add new invariants here when a convention matters enough to enforce.

## E2E (`test/e2e/`) — the shipped artifact, black-box

Runs `dist/bin.cjs` with execa in a temp cwd, asserting on stdout/stderr/exit codes — the artifact consumers get, not the source. Runs in the Push profile after the build. When you add a command, add one happy-path e2e case and one failure case asserting the envelope `code` and exit.

Conventions:

- Assert stdout purity: machine modes emit exactly one envelope line (or NDJSON events), nothing else.
- Never assert on timing, absolute paths, or ANSI — normalize first. (The Starter Contract's 5 s bound on a missing-argument failure is the one wall-clock check; it proves nothing waited on stdin.)
- Each e2e and real-store test gets a fresh temp cwd; never depend on test order.

## The Starter Contract (`scripts/starter-contract.mjs`)

The template's own guarantee, run in CI: fresh `git archive` → install → hooks → doctor → build → protocol checks → guidance journey → generator scaffold → rename journey → pack hygiene. Run it with `npm run test:starter`. If you change setup, hooks, packaging, or the protocol, commit the changes and run `npm run test:starter` locally; it archives HEAD.
