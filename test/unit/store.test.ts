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

const modify = (transform: (tasks: ReadonlyArray<Task>) => ReadonlyArray<Task>) =>
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
