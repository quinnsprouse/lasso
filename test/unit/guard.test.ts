import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { judge } from "../../.claude/hooks/guard.mjs"

// The decisions run in-process; one small suite below covers the hook's
// process contract (stdin payload, exit code, stdout decision).
const exitOf = (tool_name: string, tool_input: Record<string, string>): number =>
  judge({ tool_name, tool_input }).exit

/** The permission decision the guard prints on stdout, if any. */
const decisionOf = (tool_name: string, tool_input: Record<string, string>): string | undefined => {
  const { stdout } = judge({ tool_name, tool_input })
  return stdout === undefined
    ? undefined
    : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } })
        .hookSpecificOutput.permissionDecision
}

describe("direct-command guard", () => {
  it.each([
    "git commit -m x --no-verify",
    "git commit -nm x",
    "git push --no-verify",
    "LEFTHOOK=0 git push",
    "LEFTHOOK_SKIP=pre-push git push",
    "git config core.hooksPath /tmp/x",
    "git -c core.hooksPath=/dev/null commit -m x",
    "git push -f",
    "git push -f origin HEAD:main",
    "git push origin :main",
    "git push --delete origin main",
    "npx tsc --noEmit",
    "npx --package typescript tsc",
    "npm exec --package=vitest -- true",
    "pnpm dlx tsdown",
    "rm -rf .git",
    "rm package-lock.json",
    "rm -rf .",
    // Unambiguous prefixes git accepts, glob refspecs, and env-var config.
    "git commit --no-veri -m x",
    "git push --no-verif",
    "git push --force-with origin main",
    "git push -f origin refs/heads/*:refs/heads/*",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x",
    // Executors behind options, and the repository through an ancestor.
    "npm --yes exec tsc",
    "pnpm --silent dlx tsc",
    "pnpx tsc",
    "rm -rf ..",
    "rm -rf /",
  ])("refuses %s", (command) => {
    expect(exitOf("Bash", { command })).toBe(2)
  })

  it.each([
    "git push origin main",
    "git push --force-with-lease origin feature",
    "git push -n origin feature",
    "git config --get core.hooksPath",
    'git commit -m "document --no-verify"',
    'git commit -m "-n"',
    "LEFTHOOK=1 git status",
    "npm run check",
    "npm exec -- echo vitest",
    'echo "npx tsc"',
    "rm -rf dist coverage",
    "git commit -mdone",
    "rm -rf /tmp/elsewhere/.git",
    "rm -f .scratch/app/package-lock.json",
  ])("allows %s", (command) => {
    expect(exitOf("Bash", { command })).toBe(0)
  })

  // The hook intentionally does not interpret shell programs or wrappers.
  it.each([
    "cat <<EOF\ngit push -f\nEOF",
    "cat <<'EOF'\ngit push -f\nEOF",
    "echo '$(git push -f)'",
    "sh -c 'git push -f'",
    "find . -name package-lock.json -print | xargs rm",
    "npm run check && git push",
  ])("leaves shell programs to the shell: %s", (command) => {
    expect(exitOf("Bash", { command })).toBe(0)
  })

  it.each([
    "dist/bin.cjs",
    "coverage/index.html",
    "node_modules/effect/package.json",
    ".git/config",
    "package-lock.json",
    "test/contract/surface.snapshot.json",
    "src/guides/catalog.generated.ts",
    ".lasso/tasks.json",
  ])("protects %s", (file_path) => {
    expect(exitOf("Edit", { file_path })).toBe(2)
  })

  it("folds case where the file system does", () => {
    const folds = process.platform === "darwin" || process.platform === "win32"
    expect(exitOf("Bash", { command: "rm -rf .GIT" })).toBe(folds ? 2 : 0)
  })

  it.each(["src/meta.ts", "guides/topics/task-ids.md", "README.md"])(
    "allows edits to %s",
    (file_path) => {
      expect(exitOf("Edit", { file_path })).toBe(0)
      expect(decisionOf("Edit", { file_path })).toBeUndefined()
    },
  )

  it.each([
    ".oxlintrc.json",
    "tsconfig.json",
    "package.json",
    "lefthook-local.yml",
    ".npmrc",
    "scripts/lib/toolchain.mjs",
    "vitest.config.ts",
    "scripts/verify.mjs",
    "lefthook.yml",
    ".claude/settings.json",
    ".claude/hooks/guard.mjs",
    ".github/workflows/ci.yml",
  ])("asks a person before an edit to check configuration: %s", (file_path) => {
    expect(decisionOf("Write", { file_path })).toBe("ask")
  })
})

describe("the guard as a hook process", () => {
  const GUARD = join(import.meta.dirname, "..", "..", ".claude", "hooks", "guard.mjs")
  const hook = (payload: string) =>
    spawnSync(process.execPath, [GUARD], { input: payload, encoding: "utf8" })

  it("refuses with exit 2 and a fix line on stderr", () => {
    const result = hook(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push -f" } }),
    )
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/^guard: .*\nfix: /)
  })

  it("asks through a permission decision on stdout", () => {
    const result = hook(
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "tsconfig.json" } }),
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("ask")
  })

  it("lets an unreadable payload through", () => {
    expect(hook("not json").status).toBe(0)
  })
})
