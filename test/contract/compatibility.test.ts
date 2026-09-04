import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import { describeCli, schemaDocument } from "../../src/contract/jsonschema.ts"
import { CLI_NAME, CLI_VERSION } from "../../src/meta.ts"
import { normalizeSurface } from "./surface-snapshot.ts"

it("records the command and schema definitions for review", () => {
  const recorded = JSON.parse(
    readFileSync(join(import.meta.dirname, "surface.snapshot.json"), "utf8"),
  )
  const options = { binName: CLI_NAME, version: CLI_VERSION, contracts }
  expect(
    normalizeSurface(describeCli(options), schemaDocument(options)),
    "Command or schema definitions changed. Run npm run surface:update and review the snapshot diff for compatibility.",
  ).toEqual(recorded)
})
