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
    expect(envelope.data.$schema).toContain("2020-12")
    const create = envelope.data.commands.find((c: any) => c.name === "task create")
    expect(create.plan).toBeDefined()
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

    const confirmArgs = envelope.confirmation.confirmArgs as string[]
    const second = await run([...confirmArgs, "--json"])
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
      "plan_000000000000",
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
