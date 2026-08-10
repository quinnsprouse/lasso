import type { FileSystem, Path } from "effect"
import { Layer } from "effect"
import { StoreReader, StoreWriter } from "./store.ts"

/**
 * The canonical service set available to command handlers. Every contract's
 * requirement channel must stay within AppServices — the roster type in
 * src/commands/index.ts enforces it at compile time, so a handler that needs
 * an unwired service fails `tsc`, not the user.
 *
 * Adding a service: define it in this directory, add it to the union, and
 * merge its layer here.
 */
export type AppServices = StoreReader | StoreWriter

export const appServicesLayer: Layer.Layer<AppServices, never, FileSystem.FileSystem | Path.Path> =
  Layer.mergeAll(StoreReader.layer, StoreWriter.layer)
