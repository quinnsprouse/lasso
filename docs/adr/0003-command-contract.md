# CommandContract owns the surface; the parser is an adapter

Every command is a contract, and the parser, help, `describe`, `schema`, and docs derive from its normalized surface (`src/contract/surface.ts`), so they cannot drift — drift between surfaces is worse for an agent than a missing feature. Only `src/contract/adapter.ts` imports `effect/unstable/cli` (lint-enforced); mutations structurally require `plan`/`apply`, so `--dry-run` and exit-4 confirmation exist for every mutation by construction.
