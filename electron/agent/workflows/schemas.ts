// ── Demo workflow schemas ────────────────────────────────────────────────────

import { z } from "zod"

export const sceneSchema = z.object({
  id: z.string().describe("Stable slug, e.g. scene-01"),
  title: z.string(),
  goal: z.string().describe("What this scene demonstrates, one sentence"),
  startUrl: z.string().describe("URL the browser must be on before recording"),
  endUrl: z
    .string()
    .describe("URL prefix expected when the scene completes (continuity contract)"),
  actions: z
    .array(z.string())
    .min(1)
    .describe("Ordered human-readable browser actions for the recorder agent"),
  expectedOutcome: z
    .string()
    .describe("Verifiable end-state assertion, e.g. 'board Demio QA visible with 3 lists'"),
  narrationHint: z.string().describe("Tone/content cue for the voiceover writer"),
  minDurationSec: z.number().default(4),
  maxDurationSec: z.number().default(90),
})
export type Scene = z.infer<typeof sceneSchema>

export const scenePlanSchema = z.object({
  demoTitle: z.string(),
  targetUrl: z.string(),
  scenes: z.array(sceneSchema).min(1).max(12),
})
export type ScenePlan = z.infer<typeof scenePlanSchema>

export const verifyReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      name: z.enum(["video-exists", "duration-range", "actions-ok", "end-url"]),
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
