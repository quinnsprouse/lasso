import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"

it("generates an empty catalog and serves a standalone workflow topic", () => {
  const root = resolve(import.meta.dirname, "../..")
  const dir = mkdtempSync(join(tmpdir(), "guide-generator-"))
  try {
    mkdirSync(join(dir, "scripts/lib"), { recursive: true })
    mkdirSync(join(dir, "src/guides"), { recursive: true })
    for (const file of [
      "scripts/guides.mjs",
      "scripts/lib/toolchain.mjs",
      "src/guides/catalog.ts",
      "biome.json",
      ".gitignore",
    ]) {
      cpSync(join(root, file), join(dir, file))
    }
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction")
    execFileSync("git", ["init", "-q"], { cwd: dir })
    const generate = () => {
      execFileSync(process.execPath, ["scripts/guides.mjs"], { cwd: dir, stdio: "pipe" })
      execFileSync(process.execPath, ["scripts/guides.mjs", "--check"], { cwd: dir, stdio: "pipe" })
    }
    const inventory = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'import { guideInventory } from "./src/guides/catalog.ts"; console.log(JSON.stringify(guideInventory([])))',
          ],
          { cwd: dir, encoding: "utf8" },
        ),
      )

    generate()
    expect(inventory()).toEqual([])
    mkdirSync(join(dir, "guides/topics"), { recursive: true })
    writeFileSync(
      join(dir, "guides/topics/flow.md"),
      "---\ntopic: flow\ntitle: Flow\nbrief: Start here.\n---\n\n# Flow\n\nDo this.\n",
    )
    generate()
    expect(inventory()).toEqual([expect.objectContaining({ topic: "flow", commands: [] })])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
