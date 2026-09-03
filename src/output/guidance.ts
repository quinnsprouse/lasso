import { Schema } from "effect"

/**
 * Point-of-use guidance: the wire shapes every terminal outcome carries.
 *
 * - `next`: the agent's next move(s), each an executable argv for this binary
 *   (no bin name, exactly like `confirmArgs`) with a one-line reason. At most
 *   three, in importance order; the runtime validates each against the
 *   command surface and drops invalid ones into `warnings`.
 * - `guides`: importance-ordered guide topic ids the agent should read to
 *   build the model this outcome assumes. Fetch with `guide get <topic>`.
 *
 * Both are always present (possibly empty) so consumers never branch on
 * absence. `error.fix` remains the one required recovery sentence.
 */
export const NextAction = Schema.Struct({
  message: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
})
export type NextAction = typeof NextAction.Type

export const GuidanceFields = {
  next: Schema.Array(NextAction),
  guides: Schema.Array(Schema.String),
}

export interface Guidance {
  readonly next: ReadonlyArray<NextAction>
  readonly guides: ReadonlyArray<string>
}

export const NEXT_LIMIT = 3
