import type { AnyContract } from "./contract.ts"

/**
 * The registry holds every contract the CLI ships. The contract-invariant
 * tests run against this list, so a command that never gets registered here
 * is caught by Knip (unused export) and a command that violates an invariant
 * fails the Fast profile.
 */
const contracts = new Map<string, AnyContract>()

export const register = <C extends AnyContract>(contract: C): C => {
  if (contracts.has(contract.name)) {
    throw new Error(`duplicate command contract: "${contract.name}"`)
  }
  contracts.set(contract.name, contract)
  return contract
}

export const allContracts = (): ReadonlyArray<AnyContract> =>
  [...contracts.values()].toSorted((a, b) => a.name.localeCompare(b.name))
