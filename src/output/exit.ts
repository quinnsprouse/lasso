/**
 * The exit-code registry. Frozen: additions are allowed, changes are not —
 * agents and scripts branch on these values, and models cache them.
 */
export const ExitCode = {
  success: 0,
  confirmationRequired: 4,
  usage: 64,
  invalidData: 65,
  serviceUnavailable: 69,
  internalDefect: 70,
  cannotWrite: 73,
  transient: 75,
  auth: 77,
  config: 78,
  interrupted: 130,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]
