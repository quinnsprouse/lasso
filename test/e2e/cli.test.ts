import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execa } from "execa"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * Black-box tests against the BUILT artifact (dist/bin.cjs) — the thing that
 * ships, not the source. Runs in the Push profile, after `tsdown`.
 */

const BIN = join(import.meta.dirname, "..", "..", "dist", "bin.cjs")

let cwd: string

const run = (args: ReadonlyArray<string>, options: { env?: Record<string, string> } = {}) =>
  execa("node", [BIN, ...args], {
    cwd,
    reject: false,
    env: { ...options.env },
    extendEnv: true,
  })

const parse = (stdout: string) => JSON.parse(stdout) as Record<string, any>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "lasso-e2e-"))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe("introspection", () => {
  it("describe works with no config, no state, and exits 0", async () => {
    const result = await run(["describe", "--json"])
    expect(result.exitCode).toBe(0)
    const envelope = parse(result.stdout)
    expect(envelope.status).toBe("ok")
    expect(envelope.schemaVersion).toBe("1")
    expect(envelope.data.commands.map((c: any) => c.name)).toContain("task create")
    expect(envelope.data.protocol.exitCodes.transient).toBe(75)
  })

  it("schema emits draft 2020-12", async () => {
    const result = await run(["schema", "--json"])
    expect(result.exitCode).toBe(0)
    const envelope = parse(result.stdout)
    expect(envelope.data.dialect).toContain("2020-12")
    const create = envelope.data.commands.find((c: any) => c.name === "task create")
    expect(create.plan.$schema).toContain("2020-12")
    expect(create.params.required).toContain("title")
  })

  it("--help in json mode answers with describe data, exit 0", async () => {
    const result = await run(["--help", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).data.cli.name).toBe("lasso")
  })

  it("--version in json mode is an envelope", async () => {
    const result = await run(["--version", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).data.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe("output protocol", () => {
  it("auto-selects json when stdout is a pipe", async () => {
    const result = await run(["task", "list"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).status).toBe("ok")
  })

  it("respects LASSO_FORMAT", async () => {
    const result = await run(["task", "list"], { env: { LASSO_FORMAT: "text" } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("No tasks found.")
  })

  it("keeps stdout pure: text-mode errors go to stderr", async () => {
    const result = await run(["task", "create", "", "--yes", "--format", "text"])
    expect(result.exitCode).toBe(65)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("error:")
    expect(result.stderr).toContain("fix:")
  })

  it("emits exactly one parseable envelope on stdout for usage errors", async () => {
    const result = await run(["nonsense", "--json"])
    expect(result.exitCode).toBe(64)
    const lines = result.stdout.split("\n").filter((line) => line.length > 0)
    expect(lines.length).toBe(1)
    const envelope = parse(lines[0]!)
    expect(envelope.error.code).toBe("invalid_usage")
    expect(envelope.error.fix).toContain("describe")
  })

  it("rejects an invalid --format with exit 64 and a json envelope", async () => {
    const result = await run(["task", "list", "--format", "yaml"])
    expect(result.exitCode).toBe(64)
    expect(parse(result.stdout).error.code).toBe("invalid_usage")
  })

  it("streams ndjson with a terminal summary event", async () => {
    await run(["task", "create", "First", "--yes", "--json"])
    const result = await run(["task", "list", "--format", "ndjson", "--fields", "id,status"])
    expect(result.exitCode).toBe(0)
    const events = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
    expect(events.at(-1)!.event).toBe("summary")
    expect(events[0]!.event).toBe("item")
    expect(Object.keys(events[0]!.data).toSorted()).toEqual(["id", "status"])
  })

  it("rejects unknown projection fields with the available set", async () => {
    await run(["task", "create", "One", "--yes", "--json"])
    const result = await run(["task", "list", "--fields", "bogus", "--json"])
    expect(result.exitCode).toBe(64)
    expect(parse(result.stdout).error.fix).toContain("id")
  })
})

describe("mutation protocol", () => {
  it("walks the full plan → confirm → apply journey", async () => {
    const first = await run(["task", "create", "Ship it", "--json"])
    expect(first.exitCode).toBe(4)
    const envelope = parse(first.stdout)
    expect(envelope.status).toBe("confirmation_required")
    expect(envelope.plan.action).toBe("create_task")

    // Replayed VERBATIM: confirmArgs is the complete canonical continuation.
    const confirmArgs = envelope.confirmation.confirmArgs as string[]
    const second = await run(confirmArgs)
    expect(second.exitCode).toBe(0)
    expect(parse(second.stdout).data.created).toBe(true)

    const list = await run(["task", "list", "--json"])
    expect(parse(list.stdout).data.count).toBe(1)
  })

  it("rejects a stale confirmation token", async () => {
    const result = await run([
      "task",
      "create",
      "Something",
      "--confirm",
      "plan_0000000000000000",
      "--json",
    ])
    expect(result.exitCode).toBe(64)
    expect(parse(result.stdout).error.code).toBe("stale_confirmation")
  })

  it("--dry-run changes nothing", async () => {
    const dryRun = await run(["task", "create", "Preview", "--dry-run", "--json"])
    expect(dryRun.exitCode).toBe(0)
    expect(parse(dryRun.stdout).data.dryRun).toBe(true)

    const list = await run(["task", "list", "--json"])
    expect(parse(list.stdout).data.count).toBe(0)
  })

  it("--yes applies in one step", async () => {
    const result = await run(["task", "create", "Fast path", "--yes", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).data.created).toBe(true)
  })

  it("conflicts exit 73 with an actionable fix", async () => {
    await run(["task", "create", "Duplicate", "--yes", "--json"])
    const result = await run(["task", "create", "Duplicate", "--yes", "--json"])
    expect(result.exitCode).toBe(73)
    const envelope = parse(result.stdout)
    expect(envelope.error.code).toBe("resource_conflict")
    expect(envelope.error.fix).toContain("--if-not-exists")
    expect(envelope.error.transient).toBe(false)
  })

  it("--if-not-exists makes creation idempotent", async () => {
    await run(["task", "create", "Idem", "--yes", "--json"])
    const result = await run(["task", "create", "Idem", "--yes", "--if-not-exists", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).data.created).toBe(false)
  })
})

describe("machine-mode built-ins", () => {
  it("refuses the wizard and explicit-machine completions", async () => {
    const wizard = await run(["task", "create", "--wizard", "--json"])
    expect(wizard.exitCode).toBe(64)
    expect(parse(wizard.stdout).error.code).toBe("invalid_usage")

    const completions = await run(["--completions", "sh", "--json"])
    expect(completions.exitCode).toBe(64)
    expect(parse(completions.stdout).error.code).toBe("invalid_usage")
  })

  it("piped completions emit the raw script — the normal install path works", async () => {
    const result = await run(["--completions", "bash"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("complete")
    expect(result.stdout).not.toContain("schemaVersion")
  })

  it("--version in ndjson mode is a summary event", async () => {
    const result = await run(["--version", "--format", "ndjson"])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.trim()).event).toBe("summary")
  })

  it("--help on an unknown command is a usage error, not describe data", async () => {
    const result = await run(["nonsense", "--help", "--json"])
    expect(result.exitCode).toBe(64)
    expect(parse(result.stdout).error.code).toBe("invalid_usage")
  })

  it("confirmArgs replays verbatim even with a -- terminator", async () => {
    const first = await run(["task", "create", "--json", "--", "--weird-title"])
    expect(first.exitCode).toBe(4)
    const confirmArgs = parse(first.stdout).confirmation.confirmArgs as string[]
    const second = await run(confirmArgs)
    expect(second.exitCode).toBe(0)
    expect(parse(second.stdout).data.task.title).toBe("--weird-title")
  })

  it("repeated scalar flags are a usage error, not first-wins", async () => {
    const result = await run(["task", "list", "--status", "done", "--status", "open", "--json"])
    expect(result.exitCode).toBe(64)
  })
})

describe("progress through the shipped binary", () => {
  it("ndjson: progress events precede the summary, in order", async () => {
    await run(["task", "create", "One", "--yes", "--json"])
    const result = await run(["task", "audit", "--format", "ndjson"])
    expect(result.exitCode).toBe(0)
    const events = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.event)).toEqual(["progress", "progress", "summary"])
    expect(events[1].completed).toBe(1)
    expect(events.at(-1)!.data).toEqual({ tasks: 1, duplicateIds: 0 })
  })

  it("json: stdout is exactly one envelope; progress lines are on stderr", async () => {
    const result = await run(["task", "audit", "--json"])
    expect(result.exitCode).toBe(0)
    const stdoutLines = result.stdout.split("\n").filter((line) => line.length > 0)
    expect(stdoutLines.length).toBe(1)
    expect(JSON.parse(stdoutLines[0]!).status).toBe("ok")
    expect(result.stderr).toContain("progress[load]: reading the task store")
  })
})

describe("machine help with a full command line", () => {
  it.each([
    ["task", "create"],
    ["guide", "get"],
  ])("help for %s %s works before required arguments are known", async (...command) => {
    await Promise.all(
      ["json", "ndjson", "text"].map(async (format) => {
        const result = await run([...command, "--help", "--format", format])
        expect(result.exitCode).toBe(0)
        if (format === "json") expect(parse(result.stdout).status).toBe("ok")
        if (format === "ndjson") expect(parse(result.stdout).event).toBe("summary")
      }),
    )
  })

  it("answers describe data when the named command is followed by flags", async () => {
    const result = await run(["task", "list", "--status", "all", "--help", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).data.cli.name).toBe("lasso")
  })

  it("answers describe data when the named command is followed by a positional", async () => {
    const result = await run(["task", "create", "ignored title", "--help", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).status).toBe("ok")
  })

  it("does not mask an unknown flag placed before the command path", async () => {
    const result = await run(["--bogus", "task", "list", "--help", "--json"])
    expect(result.exitCode).toBe(64)
    expect(parse(result.stdout).error.message).toContain('unrecognized flag "--bogus"')
    const between = await run(["task", "--bogus", "list", "--help", "--json"])
    expect(between.exitCode).toBe(64)
  })

  it("skips parser-owned global flags when resolving the command path", async () => {
    const result = await run(["--log-level", "debug", "task", "list", "--help", "--json"])
    expect(result.exitCode).toBe(0)
  })

  it("still rejects an unknown leaf under a known group", async () => {
    const result = await run(["task", "bogus", "--help", "--json"])
    expect(result.exitCode).toBe(64)
    expect(parse(result.stdout).error.message).toContain('unknown command "task bogus"')
  })
})

describe("task audit failure path", () => {
  it("a corrupt store is invalid_config with exit 78 and a repair fix", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(join(cwd, ".lasso"), { recursive: true })
    await writeFile(join(cwd, ".lasso", "tasks.json"), "{ not json")
    const result = await run(["task", "audit", "--json"])
    expect(result.exitCode).toBe(78)
    const envelope = parse(result.stdout)
    expect(envelope.error.code).toBe("invalid_config")
    expect(envelope.error.fix).toContain("tasks.json")
  })
})

describe("store identity", () => {
  it("an --if-not-exists no-op does not rewrite the store file", async () => {
    const { stat } = await import("node:fs/promises")
    await run(["task", "create", "Same", "--yes", "--json"])
    const before = await stat(join(cwd, ".lasso", "tasks.json"))
    const result = await run(["task", "create", "Same", "--if-not-exists", "--yes", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).data.created).toBe(false)
    const after = await stat(join(cwd, ".lasso", "tasks.json"))
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})

describe("closed stdout", () => {
  it("a consumer that stops reading gets exit 0 and no stack trace", async () => {
    const { spawn } = await import("node:child_process")
    const child = spawn("node", [BIN, "schema", "--json"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    // Close our end immediately: the producer's writes hit EPIPE.
    child.stdout.destroy()
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    const [code] = (await once(child, "close")) as [number | null]
    expect(code).toBe(0)
    expect(stderr).not.toContain("EPIPE")
    expect(stderr).not.toContain("Unhandled")
  })
})

describe("global flags in machine formats", () => {
  it("--completions=<shell> with an explicit machine format is a usage error, not a raw script", async () => {
    const result = await run(["--completions=zsh", "--json"])
    expect(result.exitCode).toBe(64)
    expect(parse(result.stdout).error.code).toBe("invalid_usage")
  })

  it("help does not mask an invalid or missing --log-level value", async () => {
    const bogus = await run(["--log-level=bogus", "task", "list", "--help", "--json"])
    expect(bogus.exitCode).toBe(64)
    expect(parse(bogus.stdout).error.message).toContain("--log-level")
    const missing = await run(["--log-level", "--help", "--json"])
    expect(missing.exitCode).toBe(64)
    const trailing = await run(["task", "list", "--log-level=DEBUG", "--help", "--json"])
    expect(trailing.exitCode).toBe(64)
  })
})

describe("guides and guidance through the shipped binary", () => {
  it("guide list and guide get work offline with no state", async () => {
    const list = await run(["guide", "list", "--json"])
    expect(list.exitCode).toBe(0)
    const topics = parse(list.stdout).data.items.map((item: any) => item.topic)
    expect(topics).toContain("task-ids")
    const got = await run(["guide", "get", "task-ids", "--json"])
    expect(parse(got.stdout).data.content).toContain("# How task ids are derived")
    expect(parse(got.stdout).data.commands).toEqual(["task create", "task list"])
    const brief = await run(["guide", "get", "task-ids", "--brief", "--json"])
    expect(parse(brief.stdout).data.content).toBeUndefined()
    const missing = await run(["guide", "get", "nope", "--json"])
    expect(missing.exitCode).toBe(65)
    expect(parse(missing.stdout).next).toEqual([
      { message: "list the topics", args: ["guide", "list", "--json"] },
    ])
  })

  it("describe advertises guides and can be narrowed to one command", async () => {
    const full = await run(["describe", "--json"])
    const doc = parse(full.stdout).data
    expect(doc.guideTopics.map((g: any) => g.topic)).toEqual(["mutation-replay", "task-ids"])
    expect(doc.commands.find((c: any) => c.name === "task create").guides).toEqual([
      "task-ids",
      "mutation-replay",
    ])
    const one = await run(["describe", "--command", "task list", "--json"])
    const narrowed = parse(one.stdout).data
    expect(narrowed.commands.map((c: any) => c.name)).toEqual(["task list"])
    expect(narrowed.guideTopics.map((g: any) => g.topic)).toEqual(["task-ids"])
    expect(narrowed.guideTopics[0].commands).toEqual(["task create", "task list"])
    expect(one.stdout.length).toBeLessThan(12_000)
    expect(full.stdout.length).toBeLessThan(32_000)
    const unknown = await run(["describe", "--command", "nope", "--json"])
    expect(unknown.exitCode).toBe(65)
  })

  it("a conflict's first next action is executable as-is", async () => {
    await run(["task", "create", "Ship the kit", "--yes", "--json"])
    const conflict = await run(["task", "create", "  Ship: the KIT!  ", "--yes", "--json"])
    expect(conflict.exitCode).toBe(73)
    const envelope = parse(conflict.stdout)
    expect(envelope.guides[0]).toBe("task-ids")
    const followed = await run(envelope.next[0].args)
    expect(followed.exitCode).toBe(0)
  })
})

describe("group help", () => {
  it("a bare group with --json answers with describe data", async () => {
    const result = await run(["task", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).data.cli.name).toBe("lasso")
  })
})

describe("action flags in every spelling", () => {
  it.each(["--help=true", "--no-help", "-h=1"])("%s is help", async (flag) => {
    const result = await run([flag, "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).data.cli.name).toBe("lasso")
  })

  it("--help=maybe is not help and --no-completions is not completions", async () => {
    const help = await run(["--help=maybe", "--json"])
    expect(help.exitCode).toBe(64)
    const completions = await run(["--no-completions", "--json"])
    expect(completions.exitCode).toBe(64)
    expect(parse(completions.stdout).error.message).not.toContain("raw shell script")
  })

  it("help never masks a bad flag after the command or a bad completions value", async () => {
    const after = await run(["task", "list", "--json=true", "--help"])
    expect(after.exitCode).toBe(64)
    const prefix = await run(["task", "list", "--helpful", "--help", "--json"])
    expect(prefix.exitCode).toBe(64)
    const completions = await run(["--completions=bogus", "--json"])
    expect(completions.exitCode).toBe(64)
    expect(parse(completions.stdout).error.message).toContain("--completions")
  })

  it("--wizard=false in a machine format is still refused", async () => {
    const result = await run(["--wizard=false", "--json"])
    expect(result.exitCode).toBe(64)
    expect(parse(result.stdout).error.code).toBe("invalid_usage")
  })

  it("a global flag between the group and the leaf keeps runtime guidance", async () => {
    const result = await run(["task", "--log-level", "debug", "create", "x", "--dry-run", "--json"])
    expect(result.exitCode).toBe(0)
    expect(parse(result.stdout).next.length).toBe(1)
    expect(parse(result.stdout).warnings).toEqual([])
  })
})
