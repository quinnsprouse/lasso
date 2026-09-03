# Contributing

Agents read [AGENTS.md](AGENTS.md) first; this file is the human companion.

## Setup

```bash
npm ci                  # npm 11 warns about lefthook's postinstall; the hooks still install below
npm run setup           # git hooks
npm run doctor          # workspace health
```

Node 22.19 or newer and npm 10 or newer. `.node-version` pins 24 for tool managers. The demo store is `.lasso/tasks.json` under whatever directory you run the CLI in (renamed with the CLI, gitignored).

## Day to day

- `npm run check` before every commit (the pre-commit hook formats and lints staged files; commitlint checks the message).
- `npm run check:push` before every push (the pre-push hook runs it).
- One test file: `node node_modules/vitest/vitest.mjs run test/unit/token.test.ts`. E2E runs against `dist/`, so `npm run build` first, then `npm run test:e2e`.
- Do not bypass the hooks. The Claude Code guard refuses the common bypasses; humans are on their honor.

## Changing the surface

Additions run `npm run surface:update` and commit the snapshot diff. `--allow-breaking` is the reviewed override for drift the structural comparator cannot prove safe; a genuine break also bumps `SCHEMA_VERSION` and gets a CHANGELOG migration. Read the "Changing the surface" section of [AGENTS.md](AGENTS.md) first.

## Making it yours

Before the first publish of a CLI built from this template:

1. `node scripts/rename.mjs <name>` — package name, bin, skill directory, `CLI_NAME`, env prefix, state directory, docs, tests.
2. `package.json`: `name` (your npm scope), `description`, `keywords`, `repository`, `homepage`, `bugs`; `src/meta.ts`: `CLI_SUMMARY`; `LICENSE`: the copyright holder; `SECURITY.md`: your reporting path.
3. Replace the demo: `src/domain/`, `src/commands/task-*.ts`, their tests, the topics in `guides/topics/`, and the router rows in `skills/<name>/SKILL.md`. Then reset the surface baseline: `rm test/contract/surface.snapshot.json && npm run surface:update`, and lower the coverage ratchet in `vitest.config.ts` if the suite shrank.
4. Publish the first version from your terminal (below), then configure the repository as an npm trusted publisher for the package (see `.github/workflows/release.yml`); the runner needs npm 11.5.1 or newer, which Node 24 ships.

The shipped skill lands at `node_modules/<package>/skills/<name>/SKILL.md` for consumers of the published package; point an agent harness at that path (or copy it into its skills directory).

## Releasing

```bash
npm run release:prepare -- patch    # needs a clean tree; bumps package.json, the lockfile, and CLI_VERSION,
                                    # builds, verifies the binary reports the version, then runs check:push
                                    # (skip that with --quick); also accepts minor, major, or x.y.z
git add -A && git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z && git push && git push origin vX.Y.Z
```

The tag triggers `.github/workflows/release.yml`: it verifies version agreement, runs the CI profile, packs, attests the tarball, and publishes it through npm trusted publishing. No token is needed — except once. npm cannot register a trusted publisher for a package that has never been published, so bootstrap the very first version from a terminal where `npm login` has run:

```bash
npm run check:push && npm pack && npm publish ./<name>-0.1.0.tgz
```

Then add the trusted publisher on npmjs.com (repository, workflow `release.yml`) and let the tag workflow publish every later version.
