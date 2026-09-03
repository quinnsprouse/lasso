import type { describeCli, schemaDocument } from "../../src/contract/jsonschema.ts"

/**
 * The additive-only comparator shared by `compatibility.test.ts` (which fails
 * the Fast profile on drift) and `scripts/surface-snapshot.mjs` (which
 * refuses to record a breaking change). One algorithm, two callers, so the
 * updater can never erase evidence the test would have caught.
 *
 * Semantics:
 * - Objects: every recorded key must exist with an equal value (else
 *   breaking); keys only in current are additions — except NARROWING keys
 *   (JSON Schema constraints such as `minLength`, `additionalProperties`),
 *   whose appearance is breaking because existing inputs may stop validating.
 * - `required` lists: gaining a member is breaking (an existing invocation
 *   without it now fails); losing one is a loosening, reported as an addition.
 * - A new command param with `required: true` is breaking for the same reason.
 * - `prefixItems` (tuple schemas) compare positionally: order is the contract.
 * - Arrays whose items carry an identity (`name`, `key`, `cliName`, `code`):
 *   matched by identity, recursed; a missing identity is breaking, a new
 *   identity is an addition, and duplicate identities are rejected outright.
 * - Other arrays: compared as sets of JSON values — order is not part of the
 *   protocol for formats, events, choices, or `enum` lists.
 * - `description`, `summary`, and `examples` are documentation: a change is
 *   reported as an addition (record it), never as breaking.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [k: string]: Json }

type JsonRecord = { readonly [k: string]: Json }

export interface Drift {
  readonly breaking: Array<string>
  readonly additions: Array<string>
}

const IDENTITY_KEYS = ["name", "key", "cliName", "code", "topic"]

/** JSON Schema keywords whose appearance or change can reject inputs that used to validate. */
const NARROWING_KEYS = new Set(
  `minLength maxLength minimum maximum exclusiveMinimum exclusiveMaximum pattern minItems
   maxItems uniqueItems const multipleOf minProperties maxProperties additionalProperties
   propertyNames dependentRequired`.split(/\s+/),
)
/** JSON Schema keywords that constrain a value when they first appear (no keyword = anything goes). */
const CONSTRAINT_KEYS = new Set(
  `required enum const items prefixItems allOf anyOf oneOf not properties patternProperties
   ${[...NARROWING_KEYS].join(" ")}`.split(/\s+/),
)
/** Keys whose values are documentation, not protocol. */
const INFORMATIONAL_KEYS = new Set([
  "description",
  "summary",
  "examples",
  "title",
  "$comment",
  "brief",
  "bytes",
])
/** Subtrees that are illustrative shapes, not schemas: the real contract is under schema.protocol. */
const INFORMATIONAL_PATHS = [/^surface\.describe\.protocol\.globalFlags\[[^\]]*\]\.description$/]

/**
 * Direction: an INPUT schema (params, plans) breaks when it accepts less; an
 * OUTPUT schema (command output, envelopes, stream events) breaks when it
 * may produce more or promises less. `default` on a param changes what an
 * omitted input means, so it is treated like a constraint.
 */
const polarity = (path: string): "input" | "output" =>
  /\.(output|projected|plan)\b/.test(path) || /^surface\.schema\.protocol\b/.test(path)
    ? "output"
    : "input"

const isInformationalPath = (path: string): boolean =>
  INFORMATIONAL_PATHS.some((pattern) => pattern.test(path))

/** Strips documentation keys so two unkeyed items that differ only in prose compare equal. */
const stripInformational = (value: Json): Json =>
  Array.isArray(value)
    ? value.map(stripInformational)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !INFORMATIONAL_KEYS.has(key))
            .map(([key, inner]) => [key, stripInformational(inner)]),
        )
      : value
/** Arrays whose order is the contract. */
const ORDERED_KEYS = new Set(["prefixItems"])

const lastKey = (path: string): string => {
  const match = path.match(/\.([A-Za-z$_][\w$]*)(?:\[[^\]]*\])?$/)
  return match?.[1] ?? ""
}

const isRecord = (value: Json): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * A JSON Schema union branch is identified by its singleton discriminator:
 * `properties.<key>.enum: ["x"]` (the `event` of a stream event, the
 * `status` of an envelope, the `action` of a plan variant).
 */
const discriminatorOf = (value: JsonRecord): string | undefined => {
  const properties = value["properties"] ?? null
  if (!isRecord(properties)) {
    return undefined
  }
  for (const key of ["event", "status", "action", "kind", "type"]) {
    const property = properties[key] ?? null
    if (isRecord(property)) {
      const values = property["enum"] ?? null
      if (Array.isArray(values) && values.length === 1 && typeof values[0] === "string") {
        return `${key}=${values[0]}`
      }
    }
  }
  return undefined
}

const identityOf = (value: Json): string | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  for (const key of IDENTITY_KEYS) {
    const candidate = value[key]
    if (typeof candidate === "string") {
      return `${key}=${candidate}`
    }
  }
  return discriminatorOf(value)
}

const sortKeys = (value: unknown): Json =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        )
      : (value as Json)

/** The recorded shape: `describe` without the version, plus every JSON Schema `schema` emits. */
export const normalizeSurface = (
  describe: ReturnType<typeof describeCli>,
  schema: ReturnType<typeof schemaDocument>,
): Json => {
  // Topic body sizes are derived from content the snapshot does not record;
  // they would churn on every edit (and on rename), so they are not recorded.
  const guideTopics = describe.guideTopics.map(({ bytes: _bytes, ...rest }) => rest)
  const { cli, ...describeRest } = { ...describe, guideTopics }
  const { cli: schemaCli, ...schemaRest } = schema as { cli?: { name?: unknown } } & Record<
    string,
    unknown
  >
  return sortKeys({
    describe: { ...describeRest, cli: { name: cli.name } },
    schema: { ...schemaRest, cli: { name: schemaCli?.name ?? null } },
  })
}

const keyedBy = (items: ReadonlyArray<Json>, path: string): Map<string, Json> => {
  const map = new Map<string, Json>()
  for (const item of items) {
    const id = identityOf(item)
    if (id === undefined) {
      continue
    }
    if (map.has(id)) {
      throw new Error(`${path} has duplicate identity ${id}; identities must be unique`)
    }
    map.set(id, item)
  }
  return map
}

const asText = (items: ReadonlyArray<Json>) =>
  new Set(items.map((item) => JSON.stringify(stripInformational(item))))

/** Arrays whose every item carries an identity: matched by identity, recursed. */
const diffKeyed = (
  recorded: ReadonlyArray<Json>,
  current: ReadonlyArray<Json>,
  path: string,
  out: Drift,
): void => {
  const key = lastKey(path)
  const recordedById = keyedBy(recorded, path)
  const currentById = keyedBy(current, path)
  for (const [id, item] of recordedById) {
    const match = currentById.get(id)
    if (match === undefined) {
      out.breaking.push(`${path}[${id}] was removed`)
    } else {
      diffJson(item, match, `${path}[${id}]`, out)
    }
  }
  for (const [id, item] of currentById) {
    if (!recordedById.has(id)) {
      const requiredParam =
        key === "params" &&
        isRecord(item) &&
        item["required"] === true &&
        item["owner"] === "contract"
      if (requiredParam) {
        out.breaking.push(`${path}[${id}] is a new required parameter`)
      } else {
        out.additions.push(`${path}[${id}]`)
      }
    }
  }
}

const diffArrays = (
  recorded: ReadonlyArray<Json>,
  current: ReadonlyArray<Json>,
  path: string,
  out: Drift,
): void => {
  const key = lastKey(path)
  if (ORDERED_KEYS.has(key)) {
    const shared = Math.min(recorded.length, current.length)
    for (let index = 0; index < shared; index++) {
      diffJson(recorded[index]!, current[index]!, `${path}[${index}]`, out)
    }
    if (current.length < recorded.length) {
      out.breaking.push(`${path} shrank from ${recorded.length} to ${current.length} items`)
    } else if (current.length > recorded.length) {
      out.additions.push(`${path} grew to ${current.length} items`)
    }
    return
  }
  if (key === "required") {
    // Input: requiring something new breaks every invocation that omits it.
    // Output: promising less (dropping a required member) breaks consumers.
    const recordedText = asText(recorded)
    const currentText = asText(current)
    const output = polarity(path) === "output"
    for (const item of currentText) {
      if (!recordedText.has(item)) {
        ;(output ? out.additions : out.breaking).push(`${path} newly requires ${item}`)
      }
    }
    for (const item of recordedText) {
      if (!currentText.has(item)) {
        ;(output ? out.breaking : out.additions).push(`${path} no longer requires ${item}`)
      }
    }
    return
  }
  // Union branches with discriminators are matched by identity (a changed
  // branch is a nested diff, not a removal plus an addition).
  const all = [...recorded, ...current]
  if (all.length > 0 && all.every((item) => identityOf(item) !== undefined)) {
    diffKeyed(recorded, current, path, out)
    return
  }
  // Composition keywords: an output that may now be one more shape breaks
  // consumers; an input that must satisfy one more schema breaks callers.
  const output = polarity(path) === "output"
  const growthBreaks =
    (output && (key === "anyOf" || key === "oneOf")) || (!output && key === "allOf")
  const shrinkBreaks =
    (!output && (key === "anyOf" || key === "oneOf")) || (output && key === "allOf")
  if (growthBreaks || shrinkBreaks) {
    const recordedText = asText(recorded)
    const currentText = asText(current)
    for (const item of currentText) {
      if (!recordedText.has(item)) {
        ;(growthBreaks ? out.breaking : out.additions).push(`${path} gained ${item}`)
      }
    }
    for (const item of recordedText) {
      if (!currentText.has(item)) {
        ;(shrinkBreaks ? out.breaking : out.additions).push(`${path} lost ${item}`)
      }
    }
    return
  }
  const recordedText = asText(recorded)
  const currentText = asText(current)
  const informational = INFORMATIONAL_KEYS.has(key) || isInformationalPath(path)
  // An output enum that grows may produce values consumers never handled.
  const outputEnum = key === "enum" && polarity(path) === "output"
  for (const item of recordedText) {
    if (!currentText.has(item)) {
      ;(informational || outputEnum ? out.additions : out.breaking).push(`${path} lost ${item}`)
    }
  }
  for (const item of currentText) {
    if (!recordedText.has(item)) {
      ;(outputEnum && !informational ? out.breaking : out.additions).push(`${path} gained ${item}`)
    }
  }
}

export const diffJson = (recorded: Json, current: Json, path: string, out: Drift): void => {
  if (Array.isArray(recorded) && Array.isArray(current)) {
    diffArrays(recorded, current, path, out)
    return
  }
  if (isRecord(recorded) && isRecord(current)) {
    const input = polarity(path) === "input"
    for (const key of Object.keys(recorded)) {
      const currentValue = current[key]
      if (currentValue === undefined) {
        // Dropping a constraint loosens an input (fine) but weakens an output promise.
        const loosening = CONSTRAINT_KEYS.has(key) || key === "default"
        const informational = INFORMATIONAL_KEYS.has(key) || isInformationalPath(`${path}.${key}`)
        ;((loosening && input) || informational ? out.additions : out.breaking).push(
          `${path}.${key} was removed`,
        )
      } else {
        diffJson(recorded[key] ?? null, currentValue, `${path}.${key}`, out)
      }
    }
    for (const key of Object.keys(current)) {
      if (!(key in recorded)) {
        const constraint = CONSTRAINT_KEYS.has(key) || key === "default"
        if (constraint && input && !isInformationalPath(path)) {
          out.breaking.push(`${path}.${key} is a new constraint`)
        } else {
          out.additions.push(`${path}.${key}`)
        }
      }
    }
    return
  }
  if (JSON.stringify(recorded) !== JSON.stringify(current)) {
    const change = `${path} changed from ${JSON.stringify(recorded)} to ${JSON.stringify(current)}`
    const informational = INFORMATIONAL_KEYS.has(lastKey(path)) || isInformationalPath(path)
    ;(informational ? out.additions : out.breaking).push(change)
  }
}

export const diffSurface = (recorded: Json, current: Json): Drift => {
  const out: Drift = { breaking: [], additions: [] }
  diffJson(recorded, current, "surface", out)
  return out
}
