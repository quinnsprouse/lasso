import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Task } from "../../src/domain/task.ts"
import { appServicesLayer } from "../../src/services/index.ts"
import { StoreReader, StoreWriter } from "../../src/services/store.ts"

/**
 * The store against the REAL filesystem in a temp working directory: the
 * atomic modify path, corrupt-file classification, and the lock release are
 * behavior the fake layers in other suites deliberately do not cover.
 */

let dir: string
let previousCwd: string

beforeEach(async () => {
  previousCwd = process.cwd()
  dir = await mkdtemp(join(tmpdir(), "lasso-store-"))
  process.chdir(dir)
})

afterEach(async () => {
  process.chdir(previousCwd)
  await rm(dir, { recursive: true, force: true })
})

const layer = appServicesLayer.pipe(Layer.provideMerge(NodeServices.layer))

const load = Effect.gen(function* () {
  const reader = yield* StoreReader
  return yield* reader.load
}).pipe(Effect.provide(layer))

const modify = (transform: (tasks: ReadonlyArray<Task>) => ReadonlyArray<Task> | null) =>
  Effect.gen(function* () {
    const writer = yield* StoreWriter
    return yield* writer.modify(transform)
  }).pipe(Effect.provide(layer))

const seed = (id: string) =>
  new Task({ id, title: id, status: "open", createdAt: "2026-01-01T00:00:00.000Z" })

describe("store", () => {
  it("loads an empty list when no store file exists", async () => {
    expect(await Effect.runPromise(load)).toEqual([])
  })

  it("modify persists atomically and leaves no temp files or lock behind", async () => {
    await Effect.runPromise(modify(() => [seed("task_a")]))
    const written = JSON.parse(await readFile(join(dir, ".lasso", "tasks.json"), "utf8"))
    expect(written.tasks.length).toBe(1)

    const tasks = await Effect.runPromise(load)
    expect(tasks.map((task) => task.id)).toEqual(["task_a"])

    const { readdir } = await import("node:fs/promises")
    const files = await readdir(join(dir, ".lasso"))
    expect(files).toEqual(["tasks.json"])
  })

  it("modify reads current state inside the critical section", async () => {
    await Effect.runPromise(modify(() => [seed("task_a")]))
    await Effect.runPromise(modify((current) => [...current, seed("task_b")]))
    const tasks = await Effect.runPromise(load)
    expect(tasks.map((task) => task.id).toSorted()).toEqual(["task_a", "task_b"])
  })

  it("classifies invalid JSON as invalid_config with a fix", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(join(dir, ".lasso"), { recursive: true })
    await writeFile(join(dir, ".lasso", "tasks.json"), "not json")
    const error = await Effect.runPromise(load.pipe(Effect.flip))
    expect(error.code).toBe("invalid_config")
    expect(error.fix).toBeDefined()
  })

  it("classifies schema-mismatched content as invalid_config", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(join(dir, ".lasso"), { recursive: true })
    await writeFile(join(dir, ".lasso", "tasks.json"), JSON.stringify({ tasks: [{ id: 1 }] }))
    const error = await Effect.runPromise(load.pipe(Effect.flip))
    expect(error.code).toBe("invalid_config")
  })

  it("releases the lock even when the transform throws through encode", async () => {
    // A task that fails schema encoding: title must be non-empty.
    const invalid = { id: "task_x", title: "", status: "open", createdAt: "x" } as unknown as Task
    const error = await Effect.runPromise(modify(() => [invalid]).pipe(Effect.flip))
    expect(error.code).toBe("invalid_data")

    // Lock released: the next modify succeeds instead of timing out.
    await Effect.runPromise(modify(() => [seed("task_after")]))
    const tasks = await Effect.runPromise(load)
    expect(tasks.map((task) => task.id)).toEqual(["task_after"])
  })
})

describe("store concurrency and no-ops", () => {
  it("a null transform performs no write: file identity is untouched", async () => {
    await Effect.runPromise(modify(() => [seed("task_a")]))
    const { stat } = await import("node:fs/promises")
    const before = await stat(join(dir, ".lasso", "tasks.json"))

    const result = await Effect.runPromise(modify(() => null))
    expect(result.map((task) => task.id)).toEqual(["task_a"])

    const after = await stat(join(dir, ".lasso", "tasks.json"))
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it("contention on the advisory lock surfaces as transient_failure", async () => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(dir, ".lasso", "tasks.lock"), { recursive: true })
    const error = await Effect.runPromise(modify(() => [seed("task_a")]).pipe(Effect.flip))
    expect(error.code).toBe("transient_failure")
    expect(error.transient).toBe(true)
    expect(error.fix).toContain("tasks.lock")
  })

  it("an unwritable state directory fails immediately as cannot_write", async () => {
    const { chmod, mkdir } = await import("node:fs/promises")
    await mkdir(join(dir, ".lasso"), { recursive: true })
    await chmod(join(dir, ".lasso"), 0o500)
    const started = Date.now()
    const error = await Effect.runPromise(modify(() => [seed("task_a")]).pipe(Effect.flip))
    await chmod(join(dir, ".lasso"), 0o700)
    expect(error.code).toBe("cannot_write")
    // No pointless retry loop: permission failures are not contention.
    expect(Date.now() - started).toBeLessThan(500)
  })
})
