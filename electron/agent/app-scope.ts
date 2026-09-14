// ── Eval flags ───────────────────────────────────────────────────────────────
//
// Typed configuration for the evals under `electron/agent` (the `*.eval.ts`
// files, run with `bun run eval`). A flag is a variable an eval can sweep
// without a code change — `--flag.titleGenerator.model=google:gemini-3.7-flash`
// — and the schema is what validates the override. Every leaf needs a
// default; the app never reads these, only the evals do.
//
// See docs/superpowers/plans/evals.md for the tiers this serves.

import { createAppScope } from "axiom/ai"
import { z } from "zod"
import { DEFAULT_MODEL_ID } from "./types"

export const flagSchema = z.object({
  titleGenerator: z.object({
    /** `provider:model`, as `getModel` expects. */
    model: z.string().default(DEFAULT_MODEL_ID),
  }),
})

export const { flag, pickFlags } = createAppScope({ flagSchema })
