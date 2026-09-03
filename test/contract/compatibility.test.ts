import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import { describeCli, schemaDocument } from "../../src/contract/jsonschema.ts"
import { CLI_NAME, CLI_VERSION } from "../../src/meta.ts"
import type { Json } from "./surface-diff.ts"
import { diffJson, diffSurface, normalizeSurface } from "./surface-diff.ts"

/**
 * The additive-only rule, made mechanical. `surface.snapshot.json` records
 * every command, param, capability, error code, exit code, envelope shape,
 * NDJSON event, and JSON Schema the CLI has ever advertised. This test fails:
 *
 *   - when anything recorded there is missing or different now (a BREAKING
 *     change: renamed flag, removed command, changed exit code, changed
 *     default, changed output or plan schema), or
 *   - when the surface gained something the snapshot does not record yet (an
 *     ADDITIVE change that must be reviewed: run `npm run surface:update`
 *     and commit the diff).
 *
 * The snapshot is generated, never hand-edited; the guard hook refuses edits
 * and the updater refuses to record a breaking change.
 */

const SNAPSHOT = join(import.meta.dirname, "surface.snapshot.json")

describe("surface compatibility", () => {
  const recorded = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Json
  const options = { binName: CLI_NAME, version: CLI_VERSION, contracts }
  const current = normalizeSurface(describeCli(options), schemaDocument(options))
  const drift = diffSurface(recorded, current)

  it("never removes or changes anything the snapshot records (additive-only)", () => {
    expect(
      drift.breaking,
      "BREAKING surface change. Commands, flags, defaults, exit codes, error codes, envelope fields, and schemas are frozen once published. Add, never rename or remove.",
    ).toEqual([])
  })

  it("records every addition in the snapshot", () => {
    expect(
      drift.additions,
      "The surface grew. Review the change, then run `npm run surface:update` and commit test/contract/surface.snapshot.json.",
    ).toEqual([])
  })
})

const drift = (recorded: Json, current: Json) => {
  const out = { breaking: [] as Array<string>, additions: [] as Array<string> }
  diffJson(recorded, current, "s", out)
  return out
}

const out = (recorded: Json, current: Json) => {
  const o = { breaking: [] as Array<string>, additions: [] as Array<string> }
  diffJson(recorded, current, "s.output", o)
  return o
}

describe("surface comparator", () => {
  it("flags removed and changed leaves as breaking, new leaves as additions", () => {
    expect(drift({ a: 1, b: "x" }, { a: 2, c: true })).toEqual({
      breaking: ["s.a changed from 1 to 2", "s.b was removed"],
      additions: ["s.c"],
    })
  })

  it("matches keyed arrays by identity regardless of order", () => {
    const recorded = [
      { name: "a", v: 1 },
      { name: "b", v: 2 },
    ]
    expect(
      drift(recorded, [
        { name: "b", v: 2 },
        { name: "a", v: 1 },
      ]),
    ).toEqual({
      breaking: [],
      additions: [],
    })
    expect(drift(recorded, [{ name: "a", v: 1 }]).breaking).toEqual(["s[name=b] was removed"])
    expect(drift(recorded, [...recorded, { name: "c", v: 3 }]).additions).toEqual(["s[name=c]"])
    expect(
      drift(recorded, [
        { name: "a", v: 9 },
        { name: "b", v: 2 },
      ]).breaking,
    ).toEqual(["s[name=a].v changed from 1 to 9"])
  })

  it("treats an empty recorded list as keyed when the current items carry identities", () => {
    expect(drift([], [{ name: "a" }]).additions).toEqual(["s[name=a]"])
    expect(drift([], ["x"]).additions).toEqual(['s gained "x"'])
  })

  it("rejects duplicate identities instead of silently collapsing them", () => {
    expect(() => drift([{ name: "a" }, { name: "a" }], [{ name: "a" }])).toThrow(/duplicate/)
  })

  it("compares primitive lists as sets", () => {
    expect(drift(["a", "b"], ["b", "a"])).toEqual({ breaking: [], additions: [] })
    expect(drift(["a", "b"], ["a"]).breaking).toEqual(['s lost "b"'])
  })

  it("treats a newly required schema member as breaking and a dropped one as loosening", () => {
    expect(drift({ required: ["a"] }, { required: ["a", "b"] }).breaking).toEqual([
      's.required newly requires "b"',
    ])
    expect(drift({ required: ["a", "b"] }, { required: ["a"] })).toEqual({
      breaking: [],
      additions: ['s.required no longer requires "b"'],
    })
  })

  it("treats a new narrowing constraint as breaking", () => {
    expect(drift({ type: "string" }, { type: "string", minLength: 1 }).breaking).toEqual([
      "s.minLength is a new constraint",
    ])
    expect(
      drift({ type: "object" }, { type: "object", additionalProperties: false }).breaking,
    ).toEqual(["s.additionalProperties is a new constraint"])
    expect(drift({ type: "string", minLength: 1 }, { type: "string" }).additions).toEqual([
      "s.minLength was removed",
    ])
  })

  it("compares tuple schemas positionally", () => {
    const recorded = { prefixItems: [{ type: "string" }, { type: "number" }] }
    expect(
      drift(recorded, { prefixItems: [{ type: "number" }, { type: "string" }] }).breaking,
    ).toEqual([
      's.prefixItems[0].type changed from "string" to "number"',
      's.prefixItems[1].type changed from "number" to "string"',
    ])
    expect(drift(recorded, { prefixItems: [{ type: "string" }] }).breaking).toEqual([
      "s.prefixItems shrank from 2 to 1 items",
    ])
  })

  it("treats a new required contract param as breaking, an optional one as additive", () => {
    const recorded = { params: [{ key: "a", required: false, owner: "contract" }] }
    expect(
      drift(recorded, {
        params: [...recorded.params, { key: "b", required: true, owner: "contract" }],
      }).breaking,
    ).toEqual(["s.params[key=b] is a new required parameter"])
    expect(
      drift(recorded, {
        params: [...recorded.params, { key: "c", required: false, owner: "contract" }],
      }).additions,
    ).toEqual(["s.params[key=c]"])
  })

  it("applies polarity: output schemas break when they promise less or produce more", () => {
    expect(out({ required: ["a", "b"] }, { required: ["a"] }).breaking).toEqual([
      's.output.required no longer requires "b"',
    ])
    expect(out({ required: ["a"] }, { required: ["a", "b"] }).additions).toEqual([
      's.output.required newly requires "b"',
    ])
    expect(out({ enum: ["x"] }, { enum: ["x", "y"] }).breaking).toEqual([
      's.output.enum gained "y"',
    ])
    expect(drift({ enum: ["x"] }, { enum: ["x", "y"] }).additions).toEqual(['s.enum gained "y"'])
    expect(drift({ type: "string" }, { type: "string", enum: ["x"] }).breaking).toEqual([
      "s.enum is a new constraint",
    ])
    expect(drift({ type: "string" }, { type: "string", default: "x" }).breaking).toEqual([
      "s.default is a new constraint",
    ])
  })

  it("applies polarity to composition keywords", () => {
    expect(
      out({ anyOf: [{ type: "string" }] }, { anyOf: [{ type: "string" }, { type: "number" }] })
        .breaking,
    ).toEqual(['s.output.anyOf gained {"type":"number"}'])
    expect(
      drift({ anyOf: [{ type: "string" }] }, { anyOf: [{ type: "string" }, { type: "number" }] })
        .additions,
    ).toEqual(['s.anyOf gained {"type":"number"}'])
    expect(
      drift({ allOf: [{ type: "string" }] }, { allOf: [{ type: "string" }, { minLength: 1 }] })
        .breaking,
    ).toEqual(['s.allOf gained {"minLength":1}'])
  })

  it("treats removal of prose as informational", () => {
    expect(drift({ description: "a", type: "string" }, { type: "string" })).toEqual({
      breaking: [],
      additions: ["s.description was removed"],
    })
  })

  it("ignores prose inside unkeyed union branches", () => {
    expect(
      drift(
        { anyOf: [{ type: "string", description: "a" }] },
        { anyOf: [{ type: "string", description: "b" }] },
      ),
    ).toEqual({ breaking: [], additions: [] })
  })

  it("treats description, summary, and example changes as informational", () => {
    expect(drift({ summary: "a" }, { summary: "b" })).toEqual({
      breaking: [],
      additions: ['s.summary changed from "a" to "b"'],
    })
    expect(drift({ examples: ["x"] }, { examples: ["y"] }).breaking).toEqual([])
  })
})
