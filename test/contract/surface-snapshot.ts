import type { describeCli, schemaDocument } from "../../src/contract/jsonschema.ts"

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        )
      : value

/** The recorded shape: `describe` without the version, plus every JSON Schema `schema` emits. */
export const normalizeSurface = (
  describe: ReturnType<typeof describeCli>,
  schema: ReturnType<typeof schemaDocument>,
): unknown => {
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
