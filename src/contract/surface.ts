import type { AnyContract, Capabilities, ParamSpec } from "./contract.ts"
import { capabilitiesOf } from "./contract.ts"
import type { ErrorCode } from "../errors.ts"
import type { GuideTopic } from "../guides/catalog.generated.ts"
import { ERROR_CATALOG } from "../errors.ts"

/**
 * The normalized command surface: contract params PLUS the framework-owned
 * params the runtime adds, with their real CLI spellings. The parser adapter,
 * `describe`, and `schema` all consume exactly this object, so they cannot
 * disagree about what a command accepts or returns.
 */

export const kebabCase = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

export interface SurfaceParam {
  readonly key: string
  readonly cliName: string
  readonly kind: "argument" | "flag"
  readonly type: "string" | "boolean" | "integer" | "choice" | "path"
  readonly description: string
  readonly required: boolean
  readonly owner: "contract" | "framework"
  readonly alias?: string
  readonly default?: string | number | boolean
  readonly choices?: ReadonlyArray<string>
}

type ResultVariant = "success" | "dryRun" | "confirmationRequired" | "projected"

export interface CommandSurface {
  readonly contract: AnyContract
  readonly path: ReadonlyArray<string>
  readonly name: string
  readonly capabilities: Capabilities
  readonly params: ReadonlyArray<SurfaceParam>
  readonly resultVariants: ReadonlyArray<ResultVariant>
  /** Domain codes declared by the contract plus framework codes the runtime can add. */
  readonly errorCodes: ReadonlyArray<ErrorCode>
  /** Guide topics the contract declares, in declaration (importance) order. */
  readonly guides: ReadonlyArray<GuideTopic>
}

const FRAMEWORK_MUTATION_PARAMS: ReadonlyArray<SurfaceParam> = [
  {
    key: "dryRun",
    cliName: "--dry-run",
    kind: "flag",
    type: "boolean",
    description: "Render the execution plan without applying it",
    required: false,
    owner: "framework",
  },
  {
    key: "confirm",
    cliName: "--confirm",
    kind: "flag",
    type: "string",
    description: "Confirmation token from a previous run",
    required: false,
    owner: "framework",
  },
  {
    key: "yes",
    cliName: "--yes",
    kind: "flag",
    type: "boolean",
    description: "Apply without a separate confirmation step",
    required: false,
    owner: "framework",
    alias: "y",
  },
]

/** Spellings the runtime owns for every command of the matching kind. */
export const FRAMEWORK_CLI_NAMES: ReadonlyArray<string> = [
  ...FRAMEWORK_MUTATION_PARAMS.map((param) => param.cliName),
  "--fields",
]
export const FRAMEWORK_ALIASES: ReadonlyArray<string> = FRAMEWORK_MUTATION_PARAMS.flatMap(
  (param) => (param.alias !== undefined ? [param.alias] : []),
)

const fieldsParam = (fields: ReadonlyArray<string>): SurfaceParam => ({
  key: "fields",
  cliName: "--fields",
  kind: "flag",
  type: "string",
  description: `Comma-separated projection of item fields (${fields.join(", ")})`,
  required: false,
  owner: "framework",
})

/** Codes the runtime itself can produce for any command of the given kind. */
const frameworkErrorCodes = (contract: AnyContract): ReadonlyArray<ErrorCode> =>
  contract.kind === "mutation"
    ? ["invalid_usage", "invalid_data", "stale_confirmation", "internal_error", "interrupted"]
    : ["invalid_usage", "invalid_data", "internal_error", "interrupted"]

export const surfaceOf = (contract: AnyContract): CommandSurface => {
  const contractParams: Array<SurfaceParam> = Object.entries(
    contract.params as Record<string, ParamSpec>,
  ).map(([key, spec]) => {
    const param: {
      key: string
      cliName: string
      kind: "argument" | "flag"
      type: SurfaceParam["type"]
      description: string
      required: boolean
      owner: "contract"
      alias?: string
      default?: string | number | boolean
      choices?: ReadonlyArray<string>
    } = {
      key,
      cliName: spec.kind === "argument" ? `<${kebabCase(key)}>` : `--${kebabCase(key)}`,
      kind: spec.kind,
      type: spec.type,
      description: spec.description,
      required: spec.kind === "argument",
      owner: "contract",
    }
    if ("alias" in spec && spec.alias !== undefined) {
      param.alias = spec.alias
    }
    if ("default" in spec && spec.default !== undefined) {
      param.default = spec.default
    }
    if ("choices" in spec && spec.choices !== undefined) {
      param.choices = [...spec.choices]
    }
    return param
  })

  const framework: Array<SurfaceParam> =
    contract.kind === "mutation"
      ? [...FRAMEWORK_MUTATION_PARAMS]
      : contract.collection !== undefined
        ? [fieldsParam(contract.collection.fields)]
        : []

  const resultVariants: Array<ResultVariant> =
    contract.kind === "mutation"
      ? ["success", "dryRun", "confirmationRequired"]
      : contract.collection !== undefined
        ? ["success", "projected"]
        : ["success"]

  const errorCodes = [
    ...new Set<ErrorCode>([...contract.domainErrorCodes, ...frameworkErrorCodes(contract)]),
  ].toSorted()

  return {
    contract,
    path: contract.name.split(" "),
    name: contract.name,
    capabilities: capabilitiesOf(contract),
    params: [...contractParams, ...framework],
    resultVariants,
    errorCodes,
    guides: [...(contract.guides ?? [])],
  }
}

/** The error catalog as a serializable table for describe output. */
export const errorCatalogTable = (): ReadonlyArray<{
  code: ErrorCode
  exit: number
  transient: boolean
}> =>
  Object.entries(ERROR_CATALOG)
    .map(([code, meta]) => ({
      code: code as ErrorCode,
      exit: meta.exit,
      transient: meta.transient,
    }))
    .toSorted((a, b) => a.code.localeCompare(b.code))
