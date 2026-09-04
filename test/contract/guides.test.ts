import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import { surfaceOf } from "../../src/contract/surface.ts"
import { GUIDE_TOPICS } from "../../src/guides/catalog.generated.ts"
import { isGuideTopic } from "../../src/guides/catalog.ts"
import { validateInvocation } from "../../src/contract/invocation.ts"
import { CLI_NAME } from "../../src/meta.ts"

/**
 * Guide invariants: the catalog is honest and every command it mentions is
 * real. The catalog module is generated from guides/topics/*.md (the Fast
 * profile fails when it is stale), so these run against the same content the
 * binary ships.
 */

const TOPIC_DIR = join(import.meta.dirname, "..", "..", "guides", "topics")
const surfaces = contracts.map(surfaceOf)

/** Fills placeholders and splits a fenced `<bin> …` line into argv (quoted spans stay one token). */
const argvOf = (line: string): ReadonlyArray<string> =>
  line
    .replace(/<[^>]+>/g, "x")
    .match(/"[^"]*"|\S+/g)!
    .slice(1)
    .map((token) => token.replace(/^"|"$/g, ""))

describe("guide catalog", () => {
  const topics = GUIDE_TOPICS

  it("is generated from every Markdown topic on disk", () => {
    const files = (existsSync(TOPIC_DIR) ? readdirSync(TOPIC_DIR) : [])
      .filter((file) => file.endsWith(".md"))
      .toSorted()
    expect(topics.map((topic) => `${topic.topic}.md`)).toEqual(files)
  })

  it("every guide a contract declares exists", () => {
    for (const contract of contracts) {
      for (const topic of contract.guides ?? []) {
        expect(isGuideTopic(topic), `${contract.name} declares unknown guide "${topic}"`).toBe(true)
      }
    }
  })

  it("every fenced command line in every topic resolves to a real command with declared flags", () => {
    for (const topic of topics) {
      const fenced = [...topic.content.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)].flatMap((match) =>
        match[1]!.split("\n"),
      )
      const invocations = fenced.filter((line) => line.startsWith(`${CLI_NAME} `))
      for (const line of invocations) {
        expect(
          validateInvocation(surfaces, argvOf(line)),
          `${topic.topic}: ${line}`,
        ).toBeUndefined()
      }
    }
  })
})
