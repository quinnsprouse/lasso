import { createHash } from "node:crypto"

/**
 * Confirmation tokens bind a plan to its confirmation. The token is a hash of
 * the canonical (key-sorted) JSON of `{command, schemaVersion, plan}`, so any
 * drift between the plan an agent previewed and the plan that would execute
 * invalidates the token.
 * Not a secret — a binding checksum.
 */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortValue(value))

const reject = (what: string): never => {
  throw new TypeError(`plan contains ${what}; plans must round-trip through JSON`)
}

/**
 * Only JSON-representable values may be hashed. JSON.stringify silently maps
 * NaN and ±Infinity to null, drops `undefined` members and functions, and
 * serializes class instances by their enumerable fields — each of which lets
 * two different plans share a token while `apply` still sees the difference.
 * A plan carrying any of them is a contract bug: fail loudly. (-0 becomes 0
 * on the wire, which is the value the consumer and `apply` observe.)
 */
const sortValue = (value: unknown): unknown => {
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? value : reject(`a non-JSON number (${String(value)})`)
    case "string":
    case "boolean":
      return value
    case "undefined":
      return reject("undefined (omit the member instead)")
    case "bigint":
    case "function":
    case "symbol":
      return reject(`a ${typeof value}`)
    default:
      break
  }
  if (value === null) {
    return null
  }
  if (typeof value !== "object") {
    return reject(`a ${typeof value}`)
  }
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return reject("a non-plain object (encode it through the plan schema first)")
  }
  const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1))
  return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]))
}

export const planToken = (plan: unknown): string =>
  `plan_${createHash("sha256").update(canonicalJson(plan)).digest("hex").slice(0, 16)}`
