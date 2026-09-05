import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { contracts } from "../../src/commands/index.ts"
import { validateInvocation } from "../../src/contract/adapter.ts"
import { surfaceOf } from "../../src/contract/surface.ts"
import { isGuideTopic } from "../../src/guides/catalog.ts"
import { CLI_NAME } from "../../src/meta.ts"

/**
 * The shipped skill is layer one of the guidance model: only what an agent
 * must know BEFORE its first command (the safety contract) plus a router into
 * the binary's guides. References must name real commands and topics.
 */

const SKILL = join(import.meta.dirname, "..", "..", "skills", CLI_NAME, "SKILL.md")
const skill = readFileSync(SKILL, "utf8")
const surfaces = contracts.map(surfaceOf)

const frontmatter = (): Record<string, string> => {
  const match = skill.match(/^---\n([\s\S]*?)\n---\n/)
  expect(match).not.toBeNull()
  return Object.fromEntries(
    match![1]!.split("\n").map((line) => {
      const at = line.indexOf(":")
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
    }),
  )
}

/** Every backticked `<bin> …` span outside code fences, with placeholders filled. */
const invocations = (): ReadonlyArray<string> =>
  [...skill.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!)
    // Prose placeholders such as `lasso <command> --json` describe the shape, not an invocation.
    .filter((span) => span.startsWith(`${CLI_NAME} `) && !/^\S+ </.test(span))

const argvOf = (span: string): ReadonlyArray<string> =>
  span
    .replace(/<[^>]+>/g, "x")
    .match(/"[^"]*"|\S+/g)!
    .slice(1)
    .map((token) => token.replace(/^"|"$/g, ""))

describe("shipped skill", () => {
  it("carries portable frontmatter whose name matches its directory", () => {
    const meta = frontmatter()
    expect(meta["name"]).toBe(basename(dirname(SKILL)))
    expect(meta["name"]).toBe(CLI_NAME)
    expect(meta["description"]!.trim().length).toBeGreaterThan(0)
    expect(meta["description"]!.length).toBeLessThanOrEqual(1024)
  })

  it("keeps the safety contract lines an agent needs before any command", () => {
    for (const phrase of [
      "--json",
      "confirmArgs",
      "transient",
      "error.fix",
      "next",
      "guides",
      "130",
    ]) {
      expect(skill, `missing ${phrase}`).toContain(phrase)
    }
  })

  it("names only real commands with declared flags", async () => {
    await Promise.all(
      invocations().map(async (span) => {
        expect(
          await Effect.runPromise(
            validateInvocation(surfaces, argvOf(span)).pipe(Effect.provide(NodeServices.layer)),
          ),
          span,
        ).toBeUndefined()
      }),
    )
  })

  it("routes every named guide topic to a real topic", () => {
    const rows = skill
      .split("\n")
      .filter(
        (line) => line.startsWith("| ") && !line.startsWith("| Intent") && !line.startsWith("|---"),
      )
    for (const row of rows) {
      const cell = row.split("|")[3] ?? ""
      for (const topic of [...cell.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]!)) {
        expect(isGuideTopic(topic), `${topic} is not a guide topic`).toBe(true)
      }
    }
  })

  it("names only fields that exist on the wire", () => {
    // next and guides are top-level on every envelope; error holds code, message, fix, transient.
    expect(skill).not.toContain("error.next")
    expect(skill).not.toContain("error.guides")
  })
})
