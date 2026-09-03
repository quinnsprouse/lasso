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
    "git push origin :main",
    "git push --delete origin main",
    "npx tsc --noEmit",
    "npx --package typescript tsc",
    "npx @biomejs/biome@latest format .",
    "npm exec --package=vitest -- true",
    "pnpm dlx tsdown",
    "bunx vitest",
    "rm -rf .git",
    "rm -r -f .git/*",
    "rm package-loc?.json",
    "rm -rf .",
    "find . -name package-lock.json -exec rm {} +",
    "find . -name package-lock.json -print0 | xargs -0 rm",
    'sh -c "git commit --no-verify -m x"',
    'bash -lc "git commit --no-verify -m x"',
    'echo "$(git push -f origin main)"',
    "echo '$(git push -f)' \"$(git push -f)\"",
    'echo "`printf ok`$(git push -f)"',
    'echo "$(printf ok)`git push -f`"',
    'echo "$(echo $(git push -f))"',
    "echo \"$(echo ')' ; git push -f)\"",
    'echo "$(echo ")" ; git push -f)"',
    'echo "$(case x in x) git push -f;; esac)"',
    'echo "$(echo case)"; git push -f',
    'echo "$(echo safe\ncase x in x) git push -f;; esac\n)"',
    "command -p git push -f",
    "echo \"$(cat <<'EOF'\n)\nEOF\ngit push -f\n)\"",
    "cat <<E\\\nOF\nhello\nEOF\ngit push -f",
    "cat <<EOF\n$\\\n(git push -f)\nEOF",
    "function guarded { git push -f; }; guarded",
    "sudo -nu root git push -f",
    "sudo --user root git push -f",
    "find . -name package-lock.json -print | xargs -J target rm target",
    "sudo -R /tmp git push -f",
    "sudo -R/tmp git push -f",
    'env -S "git push -f"',
    "env -P /usr/bin git push -f",
    "sudo --user=root git push -f",
    "printf x | xargs --max-args 1 git push -f",
    "printf x | xargs -0n 1 git push -f",
    "git \\\n  push -f",
    "if git push -f; then :; fi",
    "while true; do git push -f; done",
    "cat <<EOF\n$(git push -f)\nEOF",
    "cat <<'EOF'\nhello\nEOF\ngit push -f",
    'echo "$(echo safe # )\ngit push -f\n)"',
    "env sh -c 'echo \"$(git push -f)\"'",
    "command eval 'echo \"$(git push -f)\"'",
    'echo "$(case y in x) echo esac;; y) git push -f;; esac)"',
    'echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(date)")")")")")"',
    "git push -f # fine",
    "echo $(git push -f)",
    "echo `git push -f`",
    'echo "$(echo "$(git push -f)")"',
    'echo "$(echo \\) ; git push -f)"',
    "printf x | xargs -I {} sh -c 'git commit --no-verify'",
    "npm exec --call=tsc",
    "npm exec --call 'env tsc --noEmit'",
    "npm exec --call 'sh -c \"tsc --noEmit\"'",
    "npm exec -c tsc",
    "npm exec --call 'npx tsc --noEmit'",
    "find . -name package-lock.json -exec /bin/rm {} +",
    "sh -c 'find . -name package-lock.json -delete'",
    "sh -c 'find . -name package-lock.json -print | xargs rm'",
    'echo "$(find . -name package-lock.json -print | xargs rm)"',
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
    "git config --get core.hooksPath",
    "git log --oneline",
    "npm run check && git push origin feature",
    "npm exec -- prettier --check .",
    "npm exec -- echo vitest",
    'echo "npx tsc"',
    "echo '$(git push -f origin HEAD)'",
    'echo "\\$(git push -f origin main)"',
    "echo safe # ; git push -f",
    'echo "$(case x in x) date;; esac)"',
    'echo "$(echo case)"; date',
    "cat <<'EOF'\ngit push -f\nEOF",
    "cat <<-'EOF' > notes.md\n\tgit push -f\n\tEOF",
    "cat <<EOF\nhello $(date) \\$(git push -f)\nEOF",
    'sudo -p "pass:" git status',
    "function helper { git status; }; helper",
    "sudo -nu root git status",
    "sudo --user root git status",
    "command -v git",
    "command -v git push -f",
    "echo \"$(cat <<'EOF'\n)\nEOF\n)\"",
    "if git status; then :; fi",
    'echo "$(case y in x) echo esac;; y) date;; esac)"',
    'echo "$(echo safe # )\ndate\n)"',
    "printf '#%s' a; echo a#b",
    "echo foo'$(git push -f origin HEAD)'",
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
