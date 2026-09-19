// Binding for `sandbox-env-pure.cjs`. Lives beside it on purpose: the main
// bundle copies every workflows/*.cjs flat into `.vite/build/`, so a runtime
// `require("./x.cjs")` only resolves in BOTH the bundle and the source tree
// when the requiring module sits in this directory.

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const pure = require("./sandbox-env-pure.cjs") as {
  sandboxEnv: (
    parent: NodeJS.ProcessEnv,
    extras: Record<string, string>
  ) => Record<string, string>
}

/** The env the agent's shell gets: an allowlist of the parent's, plus `extras`. */
export function sandboxEnv(
  parent: NodeJS.ProcessEnv,
  extras: Record<string, string>
): Record<string, string> {
  return pure.sandboxEnv(parent, extras)
}
