import { Effect, Schema } from "effect"
import type { AnyContract, QueryContract } from "../contract/contract.ts"
import { defineQuery } from "../contract/contract.ts"
import { Errors } from "../errors.ts"
import { findGuide, guideInventory, GuideSummarySchema } from "../guides/catalog.ts"
import { CLI_NAME } from "../meta.ts"

// Read the roster lazily so it can include these commands without a circular value dependency.

export const makeGuideCommands = (
  roster: () => ReadonlyArray<AnyContract>,
): { list: QueryContract<any, any>; get: QueryContract<any, any> } => ({
  list: defineQuery({
    name: "guide list",
    summary: "List every guide topic with its brief, size, and the commands it covers",
    stability: "stable",
    params: {},
    dataSchema: Schema.Struct({ items: Schema.Array(GuideSummarySchema), count: Schema.Int }),
    domainErrorCodes: [],
    examples: [
      { command: "lasso guide list --json", description: "The topic inventory as a JSON envelope" },
      {
        command: "lasso guide list --format ndjson --fields topic,brief",
        description: "Stream topics, projecting the fields an agent needs to choose one",
      },
    ],
    handler: () =>
      Effect.sync(() => {
        const items = guideInventory(roster())
        return { items, count: items.length }
      }),
    renderText: (data) =>
      data.items.length === 0
        ? "No guide topics."
        : [
            ...data.items.map((item) => `${item.topic}\t${item.bytes} bytes\t${item.brief}`),
            "",
            `Run: ${CLI_NAME} guide get <topic>`,
          ].join("\n"),
    collection: {
      fields: ["topic", "title", "brief", "bytes", "commands"],
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      items: (encoded) => (encoded as { items: ReadonlyArray<Record<string, unknown>> }).items,
    },
  }),
  get: defineQuery({
    name: "guide get",
    summary: "Read one guide topic, in full or as its brief",
    stability: "stable",
    params: {
      topic: { kind: "argument", type: "string", description: "Topic id from `guide list`" },
      brief: {
        kind: "flag",
        type: "boolean",
        description: "Return only the brief (the one-to-three sentence synopsis)",
      },
    },
    dataSchema: Schema.Struct({
      topic: Schema.String,
      title: Schema.String,
      brief: Schema.String,
      commands: Schema.Array(Schema.String),
      content: Schema.optional(Schema.String),
    }),
    domainErrorCodes: ["not_found"],
    examples: [
      { command: "lasso guide get task-ids --json", description: "One topic as a JSON envelope" },
      { command: "lasso guide get task-ids", description: "The topic as Markdown on a terminal" },
      {
        command: "lasso guide get task-ids --brief --json",
        description: "Only the synopsis, to decide whether the full topic is worth loading",
      },
    ],
    handler: Effect.fn("guideGet.handler")(function* (input) {
      const entry = findGuide(input.topic)
      if (entry === undefined) {
        return yield* Errors.notFound({
          message: `no guide topic named "${input.topic}"`,
          fix: `run ${CLI_NAME} guide list --json to see the topics`,
          next: [{ message: "list the topics", args: ["guide", "list", "--json"] }],
        })
      }
      const summary = guideInventory(roster()).find((item) => item.topic === entry.topic)
      return {
        topic: entry.topic,
        title: entry.title,
        brief: entry.brief,
        commands: summary?.commands ?? [],
        ...(input.brief ? {} : { content: entry.content }),
      }
    }),
    renderText: (data) => data.content ?? `${data.title}\n\n${data.brief}`,
  }),
})
