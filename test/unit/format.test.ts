import { describe, expect, it } from "vitest"
import { FormatNegotiationError, negotiate } from "../../src/output/format.ts"

const base = {
  argv: [] as ReadonlyArray<string>,
  stdoutIsTTY: true,
  stdinIsTTY: true,
  env: {} as Record<string, string | undefined>,
}

describe("format negotiation", () => {
  it("defaults to text on a terminal", () => {
    expect(negotiate(base).format).toBe("text")
  })

  it("auto-selects json when stdout is not a terminal", () => {
    expect(negotiate({ ...base, stdoutIsTTY: false }).format).toBe("json")
  })

  it("explicit --format text wins over auto-detection", () => {
    expect(negotiate({ ...base, stdoutIsTTY: false, argv: ["--format", "text"] }).format).toBe(
      "text",
    )
  })

  it("strips global output flags from argv", () => {
    const mode = negotiate({ ...base, argv: ["task", "list", "--json", "--no-input"] })
    expect(mode.argv).toEqual(["task", "list"])
    expect(mode.format).toBe("json")
    expect(mode.noInput).toBe(true)
  })

  it("supports --format=<value> syntax", () => {
    expect(negotiate({ ...base, argv: ["--format=ndjson"] }).format).toBe("ndjson")
  })

  it("honors LASSO_FORMAT when no flag is given", () => {
    expect(negotiate({ ...base, env: { LASSO_FORMAT: "json" } }).format).toBe("json")
  })

  it("flag beats LASSO_FORMAT", () => {
    expect(
      negotiate({ ...base, argv: ["--format", "text"], env: { LASSO_FORMAT: "json" } }).format,
    ).toBe("text")
  })

  it("treats non-tty stdin as no-input", () => {
    expect(negotiate({ ...base, stdinIsTTY: false }).noInput).toBe(true)
  })

  it("treats CI as no-input and disables color", () => {
    const mode = negotiate({ ...base, env: { CI: "true" } })
    expect(mode.noInput).toBe(true)
    expect(mode.color).toBe(false)
  })

  it("disables color under NO_COLOR and TERM=dumb", () => {
    expect(negotiate({ ...base, env: { NO_COLOR: "1" } }).color).toBe(false)
    expect(negotiate({ ...base, env: { TERM: "dumb" } }).color).toBe(false)
  })

  it("rejects an invalid --format value with the resolved mode attached", () => {
    try {
      negotiate({ ...base, stdoutIsTTY: false, argv: ["--format", "yaml"] })
      expect.unreachable("should have thrown")
    } catch (error) {
      if (!(error instanceof FormatNegotiationError)) {
        throw error
      }
      expect(error.mode.format).toBe("json")
    }
  })
})

describe("terminator and conflicts", () => {
  it("leaves everything after -- for the parser", () => {
    const mode = negotiate({ ...base, argv: ["task", "create", "--", "--json", "--format"] })
    expect(mode.argv).toEqual(["task", "create", "--", "--json", "--format"])
    expect(mode.format).toBe("text")
  })

  it("rejects conflicting explicit formats", () => {
    expect(() => negotiate({ ...base, argv: ["--json", "--format", "ndjson"] })).toThrow(
      FormatNegotiationError,
    )
  })

  it("rejects a missing --format value", () => {
    expect(() => negotiate({ ...base, argv: ["--format"] })).toThrow(FormatNegotiationError)
  })

  it("rejects an invalid LASSO_FORMAT instead of ignoring it", () => {
    expect(() => negotiate({ ...base, env: { LASSO_FORMAT: "yaml" } })).toThrow(
      FormatNegotiationError,
    )
  })

  it("distinguishes explicit formats from auto-detection", () => {
    expect(negotiate({ ...base, stdoutIsTTY: false }).explicitFormat).toBe(false)
    expect(negotiate({ ...base, argv: ["--json"] }).explicitFormat).toBe(true)
    expect(negotiate({ ...base, env: { LASSO_FORMAT: "json" } }).explicitFormat).toBe(true)
  })

  it("records an explicit help request", () => {
    expect(negotiate({ ...base, argv: ["--help"] }).helpRequested).toBe(true)
    expect(negotiate({ ...base, argv: ["--", "--help"] }).helpRequested).toBe(false)
  })
})

describe("built-in output policy", () => {
  it("allows the wizard only on an interactive text terminal", () => {
    expect(negotiate({ ...base, argv: ["--wizard"] }).format).toBe("text")
    expect(() => negotiate({ ...base, argv: ["--wizard", "--json"] })).toThrow(/interactive/)
    expect(() => negotiate({ ...base, argv: ["--wizard", "--no-input"] })).toThrow(/interactive/)
    expect(() => negotiate({ ...base, argv: ["--no-wizard"], stdinIsTTY: false })).toThrow(
      /interactive/,
    )
  })

  it("allows piped completion scripts but rejects explicit machine formats", () => {
    expect(negotiate({ ...base, stdoutIsTTY: false, argv: ["--completions", "bash"] }).format).toBe(
      "text",
    )
    expect(() => negotiate({ ...base, argv: ["--completions=bash", "--json"] })).toThrow(
      /raw shell script/,
    )
    expect(() => negotiate({ ...base, argv: ["--completions", "bogus"] })).toThrow(/invalid value/)
  })

  it("leaves action-like positional values after the terminator alone", () => {
    expect(
      negotiate({ ...base, argv: ["--json", "--", "--wizard", "--completions"] }).argv,
    ).toEqual(["--", "--wizard", "--completions"])
  })
})
