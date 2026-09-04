import { Schema } from "effect"
import type { AnyContract } from "../contract/contract.ts"
import type { GuideEntry, GuideTopic } from "./catalog.generated.ts"
import { GUIDE_TOPICS } from "./catalog.generated.ts"

// Markdown is embedded by scripts/guides.mjs; command references come from the roster.

export type { GuideEntry, GuideTopic }

export const findGuide = (topic: string): GuideEntry | undefined =>
  GUIDE_TOPICS.find((entry) => entry.topic === topic)

export const isGuideTopic = (topic: string): topic is GuideTopic =>
  GUIDE_TOPICS.some((entry) => entry.topic === topic)

export type GuideSummary = typeof GuideSummarySchema.Type

/** Commands referencing each topic, derived from the roster. */
const commandsByTopic = (contracts: ReadonlyArray<AnyContract>): Map<string, Array<string>> => {
  const map = new Map<string, Array<string>>()
  for (const contract of contracts) {
    for (const topic of contract.guides ?? []) {
      const list = map.get(topic) ?? []
      list.push(contract.name)
      map.set(topic, list)
    }
  }
  for (const list of map.values()) {
    list.sort()
  }
  return map
}

/**
 * The inventory `describe` and `guide list` publish: everything but the body.
 * Coverage is always derived from the FULL roster; `only` (describe
 * --command) restricts which topics are listed to those that command declares.
 */
export const guideInventory = (
  contracts: ReadonlyArray<AnyContract>,
  only?: string,
): ReadonlyArray<GuideSummary> => {
  const referenced = commandsByTopic(contracts)
  const wanted =
    only === undefined
      ? undefined
      : new Set(contracts.find((contract) => contract.name === only)?.guides ?? [])
  return GUIDE_TOPICS.filter((entry) => wanted === undefined || wanted.has(entry.topic)).map(
    (entry) => ({
      topic: entry.topic,
      title: entry.title,
      brief: entry.brief,
      bytes: Buffer.byteLength(entry.content, "utf8"),
      commands: referenced.get(entry.topic) ?? [],
    }),
  )
}

/** The wire shape of one inventory row, shared by `guide list` and `describe`. */
export const GuideSummarySchema = Schema.Struct({
  topic: Schema.String,
  title: Schema.String,
  brief: Schema.String,
  bytes: Schema.Int,
  commands: Schema.Array(Schema.String),
})
