import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const GUARD = join(import.meta.dirname, "..", "..", ".claude", "hooks", "guard.mjs")
const exitOf = (tool_name: string, tool_input: Record<string, string>): number => {
  try {
    execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_name, tool_input }),
      stdio: ["pipe", "ignore", "ignore"],
    })
    return 0
  } catch (error) {
    return (error as { status?: number }).status ?? 1
  }
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

  it.each(["src/meta.ts", "guides/topics/task-ids.md", "package.json", "README.md"])(
    "allows edits to %s",
    (file_path) => {
      expect(exitOf("Edit", { file_path })).toBe(0)
    },
  )
})
