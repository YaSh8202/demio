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

/**
 * The model evals run against unless a flag says otherwise. Deliberately
 * NOT the app's DEFAULT_MODEL_ID: that is an Anthropic model, and the eval
 * runner can only use keys from the environment — the one in `.env` here is
 * Google's. Override per run with `--flag.<capability>.model=provider:id`.
 */
export const EVAL_DEFAULT_MODEL_ID = "google:gemini-3.8-flash"

export const flagSchema = z.object({
  titleGenerator: z.object({
    /** `provider:model`, as `getModel` expects. */
    model: z.string().default(EVAL_DEFAULT_MODEL_ID),
  }),
  recovery: z.object({
    model: z.string().default(EVAL_DEFAULT_MODEL_ID),
  }),
  narrator: z.object({
    model: z.string().default(EVAL_DEFAULT_MODEL_ID),
  }),
})

export const { flag, pickFlags } = createAppScope({ flagSchema })
