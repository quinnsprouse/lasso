import { describe, expect, it } from "vitest"
import type { OutputMode } from "../../src/output/format.ts"
import type { Outcome } from "../../src/output/outcome.ts"
import { renderOutcome } from "../../src/output/outcome.ts"

/**
 * renderOutcome is the wire format. This suite pins every outcome × format
 * cell, including the ones the demo commands don't naturally produce.
 */

const mode = (format: OutputMode["format"], color = false): OutputMode => ({
  format,
  noInput: true,
  color,
  argv: [],
  helpRequested: false,
  explicitFormat: true,
})

const ok: Outcome = {
  kind: "ok",
  data: { value: 1 },
  text: "one",
  warnings: ["heads up"],
}

const confirmation: Outcome = {
  kind: "confirmation",
  plan: { action: "x" },
  token: "plan_abc",
  confirmArgs: ["thing", "do", "a title", "--confirm", "plan_abc"],
  text: "Will do x",
}

const failure: Outcome = {
  kind: "failure",
  code: "transient_failure",
  message: "busy",
  fix: "retry",
  transient: true,
  details: { attempt: 2 },
}

describe("ok", () => {
  it("json: one envelope with warnings inline", () => {
    const writes = renderOutcome(mode("json"), "lasso", ok)
    expect(writes.length).toBe(1)
    const envelope = JSON.parse(writes[0]!.text)
    expect(envelope.warnings).toEqual(["heads up"])
  })

  it("ndjson without items: warning event then summary", () => {
    const events = renderOutcome(mode("ndjson"), "lasso", ok).map((w) => JSON.parse(w.text))
    expect(events.map((event) => event.event)).toEqual(["warning", "summary"])
  })

  it("ndjson with items: warning, items, then summary count", () => {
    const events = renderOutcome(mode("ndjson"), "lasso", {
      ...ok,
      items: [{ id: 1 }, { id: 2 }],
    }).map((w) => JSON.parse(w.text))
    expect(events.map((event) => event.event)).toEqual(["warning", "item", "item", "summary"])
    expect(events.at(-1)!.data).toEqual({ count: 2 })
  })

  it("text: warnings to stderr, body to stdout", () => {
    const writes = renderOutcome(mode("text"), "lasso", ok)
    expect(writes[0]).toEqual({ stream: "stderr", text: "warning: heads up\n" })
    expect(writes[1]).toEqual({ stream: "stdout", text: "one\n" })
  })

  it("text without renderText falls back to pretty JSON", () => {
    const writes = renderOutcome(mode("text"), "lasso", { kind: "ok", data: { a: 1 } })
    expect(writes[0]!.text).toContain('"a": 1')
  })
})

describe("confirmation", () => {
  it("json: envelope with shell-quoted display command and raw confirmArgs", () => {
    const writes = renderOutcome(mode("json"), "lasso", confirmation)
    const envelope = JSON.parse(writes[0]!.text)
    expect(envelope.confirmation.confirmArgs).toEqual(confirmation.confirmArgs)
    expect(envelope.confirmation.confirmCommand).toBe("lasso thing do 'a title' --confirm plan_abc")
  })

  it("ndjson: a confirmation_required terminal event", () => {
    const events = renderOutcome(mode("ndjson"), "lasso", confirmation).map((w) =>
      JSON.parse(w.text),
    )
    expect(events.length).toBe(1)
    expect(events[0]!.event).toBe("confirmation_required")
  })

  it("text: plan and re-run instructions on stderr only", () => {
    const writes = renderOutcome(mode("text"), "lasso", confirmation)
    expect(writes.every((write) => write.stream === "stderr")).toBe(true)
    expect(writes[0]!.text).toContain("Will do x")
    expect(writes[0]!.text).toContain("--confirm plan_abc")
  })
})

describe("failure", () => {
  it("json: envelope keeps fix, transient, details", () => {
    const envelope = JSON.parse(renderOutcome(mode("json"), "lasso", failure)[0]!.text)
    expect(envelope.error).toEqual({
      code: "transient_failure",
      message: "busy",
      fix: "retry",
      transient: true,
      details: { attempt: 2 },
    })
  })

  it("ndjson: an error terminal event", () => {
    const event = JSON.parse(renderOutcome(mode("ndjson"), "lasso", failure)[0]!.text)
    expect(event.event).toBe("error")
  })

  it("text: stderr with fix and transient note; color only when enabled", () => {
    const plain = renderOutcome(mode("text"), "lasso", failure)[0]!
    expect(plain.stream).toBe("stderr")
    expect(plain.text).toContain("fix: retry")
    expect(plain.text).toContain("transient")
    expect(plain.text).not.toContain("[31m")

    const colored = renderOutcome(mode("text", true), "lasso", failure)[0]!
    expect(colored.text).toContain("[31m")
  })
})
