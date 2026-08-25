// ── Scene script contract (rehearse → record) ────────────────────────────────
//
// The executable half of a scene. Rehearsal proves each action and emits this;
// the record pass replays it verbatim. Runtime defaults are mirrored in
// `replay-pure.cjs`'s `normalizeScript` — change both together.

import { z } from "zod"

export const scriptedActionSchema = z.object({
  cmd: z
    .string()
    .describe(
      "One full agent-browser command, e.g. `click 'form button[type=\"submit\"]'`. " +
        "Must use a durable locator (role + name), never a snapshot ref like @e17 — " +
        "refs are resolved against a live RefMap that does not survive a page load."
    ),
  assert: z
    .string()
    .optional()
    .describe(
      "Arguments to `agent-browser wait` that prove this step landed, " +
        "e.g. `--url 'https://app.x.com/b/'` or `--text \"Saved\"`. " +
        "A missing assert means the step is unverified — allowed, but discouraged."
    ),
  settleMs: z
    .number()
    .default(600)
    .describe("Minimum dwell after the step, so the viewer sees the result"),
  narrationAnchor: z
    .number()
    .optional()
    .describe("Index of the narration segment that plays over this step"),
})
export type ScriptedAction = z.infer<typeof scriptedActionSchema>

export const sceneScriptSchema = z.object({
  sceneId: z.string(),
  continuity: z
    .enum(["independent", "chained"])
    .default("independent")
    .describe(
      "`chained` continues on the live page via `record restart` (no reload); " +
        "`independent` re-opens startUrl and starts a fresh recording context"
    ),
  oneShot: z
    .boolean()
    .default(false)
    .describe("This flow cannot be run twice — see the spec's §11"),
  startUrl: z.string(),
  endUrl: z
    .string()
    .describe(
      "Observed during rehearsal, not guessed. Used to re-position on retry."
    ),
  actions: z.array(scriptedActionSchema).min(1),
})
export type SceneScript = z.infer<typeof sceneScriptSchema>
