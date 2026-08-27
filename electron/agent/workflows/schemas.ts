// ── Demo workflow schemas ────────────────────────────────────────────────────

import { z } from "zod"

import { sceneScriptSchema } from "./script-schema"

export const sceneSchema = z.object({
  id: z.string().describe("Stable slug, e.g. scene-01"),
  title: z.string(),
  goal: z.string().describe("What this scene demonstrates, one sentence"),
  startUrl: z.string().describe("URL the browser must be on before recording"),
  endUrl: z
    .string()
    .describe(
      "URL prefix expected when the scene completes. Documentation only — the " +
        "authoritative end state is the last scripted action's `assert`, observed " +
        "during rehearsal rather than guessed here."
    ),
  actions: z
    .array(z.string())
    .min(1)
    .describe(
      "Ordered human-readable summary of what happens in this scene. " +
        "Documentation for the reviewer and the narrator; the executable form " +
        "is `script`."
    ),
  script: sceneScriptSchema
    .optional()
    .describe(
      "Executable script produced by rehearsal. When present the record pass " +
        "replays it deterministically and `actions` is documentation only."
    ),
  expectedOutcome: z
    .string()
    .describe("Verifiable end-state assertion, e.g. 'board Demio QA visible with 3 lists'"),
  narrationHint: z.string().describe("Tone/content cue for the voiceover writer"),
})
export type Scene = z.infer<typeof sceneSchema>

export const scenePlanSchema = z.object({
  demoTitle: z.string(),
  targetUrl: z.string(),
  // No upper bound: scene count is a narrative decision the rehearsal agent
  // makes per demo. Long flows are split into consecutive `chained` scenes
  // rather than one long scene, which keeps the retake unit small.
  scenes: z.array(sceneSchema).min(1),
})
export type ScenePlan = z.infer<typeof scenePlanSchema>

export const verifyReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      name: z.enum([
        "video-exists",
        "duration-range",
        "actions-ok",
        "end-url",
        "black-frames",
        "freeze-frames",
        "audio-track",
      ]),
      ok: z.boolean(),
      detail: z.string(),
    })
  ),
})
export type VerifyReport = z.infer<typeof verifyReportSchema>

export const sceneResultSchema = z.object({
  sceneId: z.string(),
  videoPath: z.string().describe("Absolute path to scene .webm"),
  actionsPath: z.string().describe("Absolute path to actions.jsonl"),
  durationSec: z.number(),
  endUrl: z.string(),
  attempts: z.number(),
  verify: verifyReportSchema,
})
export type SceneResult = z.infer<typeof sceneResultSchema>
