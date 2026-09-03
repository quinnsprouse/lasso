## What

<!-- one paragraph: the change and why -->

## Checks

- [ ] `npm run check:push` is green locally
- [ ] Surface: no change / additive (snapshot diff reviewed) / reviewed comparator override (`--allow-breaking`; CHANGELOG explains why no `SCHEMA_VERSION` bump) / breaking (`SCHEMA_VERSION` bumped, CHANGELOG migration written, maintainer approved)
- [ ] New commands have a happy-path and a failure e2e case
- [ ] Docs updated where a file, flag, code, or count changed
