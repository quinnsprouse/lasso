/** The guard's verdict for one PreToolUse payload (see guard.mjs). */
export interface Verdict {
  readonly exit: 0 | 2
  readonly stdout?: string
  readonly stderr?: string
}

export declare const judge: (input: unknown) => Verdict
