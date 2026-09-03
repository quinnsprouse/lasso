import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import { Task } from "../../src/domain/task.ts"
import { GUIDE_TOPICS } from "../../src/guides/catalog.generated.ts"
import { lines, makeInvoke } from "./harness.ts"

/**
 * The shipped roster, run in-process: every command that is not otherwise
 * covered by a unit suite is exercised here through the whole runtime, so
 * its handler, text rendering, and guidance are proven without the binary.
 */

const invoke = makeInvoke(contracts)
const topic = GUIDE_TOPICS[0]!.topic

const task = (id: string) =>
  new Task({ id, title: `Task ${id}`, status: "open", createdAt: "2026-01-01T00:00:00.000Z" })

describe("guide list", () => {
  it("lists every catalog topic with brief, size, and covering commands", async () => {
    const result = await invoke(["guide", "list"])
    expect(result.code).toBe(0)
    const [envelope] = lines(result.stdout)
    expect(envelope!.status).toBe("ok")
    expect(envelope!.data.count).toBe(GUIDE_TOPICS.length)
    const topics = envelope!.data.items.map((item: { topic: string }) => item.topic)
    expect(topics).toEqual(GUIDE_TOPICS.map((entry) => entry.topic))
    for (const item of envelope!.data.items) {
      expect(item.bytes).toBeGreaterThan(0)
      expect(item.brief.length).toBeGreaterThan(0)
      expect(item.commands.length).toBeGreaterThan(0)
    }
  })

  it("streams topics as items and projects fields", async () => {
    const result = await invoke(["guide", "list", "--fields", "topic,brief"], "ndjson")
    expect(result.code).toBe(0)
    const events = lines(result.stdout, "ndjson")
    const items = events.filter((event) => event.event === "item")
    expect(items).toHaveLength(GUIDE_TOPICS.length)
    expect(Object.keys(items[0]!.data)).toEqual(["topic", "brief"])
    expect(events.at(-1)!.event).toBe("summary")
  })

  it("renders a text table that ends with the next command to run", async () => {
    const result = await invoke(["guide", "list"], "text")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`${topic}\t`)
    expect(result.stdout).toContain("Run: lasso guide get <topic>")
  })
})

describe("guide get", () => {
  it("serves one topic in full with the commands that declare it", async () => {
    const result = await invoke(["guide", "get", topic])
    expect(result.code).toBe(0)
    const [envelope] = lines(result.stdout)
    expect(envelope!.data.topic).toBe(topic)
    expect(envelope!.data.title.length).toBeGreaterThan(0)
    expect(envelope!.data.content).toContain(envelope!.data.title)
    expect(envelope!.data.commands.length).toBeGreaterThan(0)
  })

  it("--brief drops the content and keeps the synopsis", async () => {
    const result = await invoke(["guide", "get", topic, "--brief"])
    expect(result.code).toBe(0)
    const [envelope] = lines(result.stdout)
    expect(envelope!.data.content).toBeUndefined()
    expect(envelope!.data.brief.length).toBeGreaterThan(0)
  })

  it("text mode prints the Markdown, or the title and brief when --brief", async () => {
    const full = await invoke(["guide", "get", topic], "text")
    expect(full.code).toBe(0)
    expect(full.stdout.startsWith("---")).toBe(false)
    const brief = await invoke(["guide", "get", topic, "--brief"], "text")
    expect(brief.code).toBe(0)
    expect(brief.stdout.split("\n\n")).toHaveLength(2)
  })

  it("an unknown topic is not_found with a next action back to the list", async () => {
    const result = await invoke(["guide", "get", "no-such-topic"])
    expect(result.code).toBe(65)
    const [envelope] = lines(result.stdout)
    expect(envelope!.status).toBe("error")
    expect(envelope!.error.code).toBe("not_found")
    expect(envelope!.next).toEqual([
      { message: "list the topics", args: ["guide", "list", "--json"] },
    ])
  })
})

describe("task audit", () => {
  it("counts tasks and duplicate ids", async () => {
    const result = await invoke(["task", "audit"], "json", [
      task("task_a"),
      task("task_b"),
      task("task_a"),
    ])
    expect(result.code).toBe(0)
    const [envelope] = lines(result.stdout)
    expect(envelope!.data).toEqual({ tasks: 3, duplicateIds: 1 })
    // json mode: progress goes to stderr, stdout stays one envelope.
    expect(lines(result.stdout)).toHaveLength(1)
    expect(result.stderr).toContain("progress[load]")
    expect(result.stderr).toContain("progress[scan]: checking ids (3/3)")
  })

  it("ndjson: load and scan progress precede the summary; an empty store is uncounted", async () => {
    const result = await invoke(["task", "audit"], "ndjson", [])
    expect(result.code).toBe(0)
    const events = lines(result.stdout, "ndjson")
    expect(events.map((event) => event.event)).toEqual(["progress", "progress", "summary"])
    expect(events[1]!.phase).toBe("scan")
    expect(events[1]!.completed).toBeUndefined()
    expect(events[2]!.data).toEqual({ tasks: 0, duplicateIds: 0 })
  })

  it("text mode names the duplicate count", async () => {
    const clean = await invoke(["task", "audit"], "text", [task("task_a")])
    expect(clean.stdout).toContain("1 task(s), no duplicate ids")
    const dirty = await invoke(["task", "audit"], "text", [task("task_a"), task("task_a")])
    expect(dirty.stdout).toContain("2 task(s), 1 duplicate id(s)")
  })
})
