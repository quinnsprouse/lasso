import type { FileSystem, Path } from "effect"
import { Layer } from "effect"
import { Progress } from "../output/progress.ts"
import type { Renderer } from "../output/renderer.ts"
import { StoreReader, StoreWriter } from "./store.ts"

/**
 * Capability sets by contract role. The roster type in src/commands/index.ts
 * pins each handler to its set, so the compiler rejects a query or plan that
 * asks for write capabilities and an apply that asks for read ones — see
 * test/contract/type-fixtures.ts for the negative proofs.
 *
 * Adding a service: define it in this directory, add it to the right unions,
 * and merge its layer into appServicesLayer.
 */
export type QueryServices = StoreReader | Progress
export type PlanServices = StoreReader | Progress
export type ApplyServices = StoreWriter | Progress
export type AppServices = StoreReader | StoreWriter | Progress

export const appServicesLayer: Layer.Layer<
  AppServices,
  never,
  FileSystem.FileSystem | Path.Path | Renderer
> = Layer.mergeAll(StoreReader.layer, StoreWriter.layer, Progress.layer)
