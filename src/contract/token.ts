import { createHash } from "node:crypto"

/**
 * Confirmation tokens bind a plan to its confirmation. The token is a hash of
 * the canonical (key-sorted) JSON of the plan, so any drift between the plan
 * an agent previewed and the plan that would execute invalidates the token.
 * Not a secret — a binding checksum.
 */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortValue(value))

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]))
  }
  return value
}

export const planToken = (plan: unknown): string =>
  `plan_${createHash("sha256").update(canonicalJson(plan)).digest("hex").slice(0, 12)}`
