import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The guard hook, judged by the table in docs/agents/GUARDS.md: every refused
 * form exits 2, every legitimate form exits 0. The hook is a speed bump, not
 * a sandbox; these rows are the bump's exact shape.
 */
const GUARD = join(import.meta.dirname, "..", "..", ".claude", "hooks", "guard.mjs")

const exitOf = (payload: Record<string, unknown>): number => {
  try {
    execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify(payload),
      stdio: ["pipe", "ignore", "ignore"],
    })
    return 0
  } catch (error) {
    return (error as { status?: number }).status ?? 1
  }
}
const bash = (command: string) => exitOf({ tool_name: "Bash", tool_input: { command } })
const edit = (file_path: string) => exitOf({ tool_name: "Edit", tool_input: { file_path } })

describe("guard hook", () => {
  it.each([
    "git commit -m x --no-verify",
    "git commit -nm x",
    'git commit -m "x" -n',
    "git merge --no-verify topic",
    "git push --no-verify",
    "LEFTHOOK=0 git push",
    "env LEFTHOOK=0 git push",
    "export LEFTHOOK_SKIP=x; git push",
    "git config core.hooksPath /tmp/x",
    "git -c core.hooksPath=/dev/null commit -m x",
    "git --config-env core.hooksPath=HOOKS commit -m x",
    "git push -f",
    "git push --force origin main",
    "git push -f origin HEAD:main",
    "git push -f origin HEAD",
    "git push \\\n  --force",
    "git push origin :main",
    "git push --delete origin main",
    "npx tsc --noEmit",
    "npx --package typescript tsc",
    "npx @biomejs/biome@latest format .",
    "npm exec --package=vitest -- true",
    "npm exec --call 'env tsc --noEmit'",
    "npm exec -c tsc",
    "pnpm dlx tsdown",
    "bunx vitest",
    "rm -rf .git",
    "rm -r -f .git/*",
    "rm package-loc?.json",
    "rm -rf .",
    "rm -rf $(pwd)",
    "find . -name package-lock.json -exec rm {} +",
    "find . -name package-lock.json -delete",
    "find . -name package-lock.json -print0 | xargs -0 rm",
    'sh -c "git commit --no-verify -m x"',
    'bash -lc "git commit --no-verify -m x"',
    "sh -c 'find . -name package-lock.json -print | xargs rm'",
    "printf x | xargs -I {} sh -c 'git commit --no-verify'",
    "sudo -u root git push -f",
    "if git push -f; then :; fi",
    'echo "$(git push -f origin main)"',
    "echo `git push -f`",
    'echo "$(echo ")" ; git push -f)"',
    "cat <<EOF\n$(git push -f)\nEOF",
    "cat <<'EOF'\nhello\nEOF\ngit push -f",
    "git push -f # fine",
  ])("refuses: %s", (command) => {
    expect(bash(command)).toBe(2)
  })

  it.each([
    "git push origin main",
    "git push origin feature -f",
    "git push --force-with-lease origin feature/x",
    "git push -n origin feature",
    "git push origin :feature",
    "git merge -n topic",
    'git commit -m "-n"',
    'git commit -m "fix: no-verify docs"',
    'git commit -m "a && b"',
    'git commit -m "use `npm run check` before pushing"',
    "git config --get core.hooksPath",
    "git log --oneline",
    "npm run check && git push origin feature",
    "npm exec -- prettier --check .",
    "npm exec -- echo vitest",
    'echo "npx tsc"',
    "echo '$(git push -f origin HEAD)'",
    'echo "\\$(git push -f origin main)"',
    "echo safe # ; git push -f",
    "cat <<'EOF'\ngit push -f\nEOF",
    "cat <<-'EOF' > notes.md\n\tgit push -f\n\tEOF",
    "node - <<'EOF'\nconsole.log(1)\nEOF\nnpm run check",
    "cat <<EOF\nhello $(date)\nEOF",
    'sudo -p "pass:" git status',
    "if git status; then :; fi",
    "npx skills experimental_install",
    "rm -rf dist coverage",
    "rm -rf .lasso",
    "rm -rf node_modules",
    'rm -rf "$dir"',
    'find . -name "*.log" -print0 | xargs -0 rm',
    "node scripts/verify.mjs fast",
    "find . -name package-lock.json -print; rm harmless.tmp",
    "find . -name package-lock.json -print && rm harmless.tmp",
    "find . -name package-lock.json -print || rm harmless.tmp",
  ])("allows: %s", (command) => {
    expect(bash(command)).toBe(0)
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
  ])("refuses edits to %s", (path) => {
    expect(edit(path)).toBe(2)
  })

  it.each(["src/meta.ts", "guides/topics/task-ids.md", "package.json", "README.md"])(
    "allows edits to %s",
    (path) => {
      expect(edit(path)).toBe(0)
    },
  )
})
