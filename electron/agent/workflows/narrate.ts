// ── Narrator ─────────────────────────────────────────────────────────────────
//
// The one model call that turns a recorded demo into voiceover lines. Split
// out of `demo-video.ts`'s `narrateStep` so it can be called on its own —
// by the workflow with real scene results, and by `narrate.eval.ts` with
// the same inputs read from fixtures. The step keeps the voice/key gate and
// the transcript write; this file is exactly the model boundary.

import { createRequire } from "node:module"
import { z } from "zod"
import { createDemioAgent } from "../demio-agent"
import type { ActionEntry } from "./sync"

const require = createRequire(import.meta.url)
const edl = require("./edl-pure.cjs") as {
  EDL_DEFAULTS: Record<string, number>
  groupActions: (
    entries: ActionEntry[],
    mergeGapMs: number
  ) => Array<{ startMs: number; endMs: number; actionIdxs: number[] }>
}

/**
 * The pace the narrator is asked to write for, and the pace the pacing
 * check assumes. One constant so the prompt and the estimate cannot drift.
 */
export const NARRATION_WORDS_PER_MINUTE = 150

/** Spoken length of a line at the target pace, before any TTS has run. */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.round((words / NARRATION_WORDS_PER_MINUTE) * 60_000)
}

const MS_PER_WORD = 60_000 / NARRATION_WORDS_PER_MINUTE

/**
 * How many words fit under each anchor without freezing the video.
 *
 * The sync engine (`edl-pure.cjs`) gives every action group a footage
 * window — pre-roll, the actions, post-roll — and every intro/outro a
 * minimum hold; a line longer than its window is covered by cloning the
 * last frame. These budgets are that arithmetic run forward, so the
 * narrator writes to the footage instead of the engine stretching the
 * footage to the narration. Same grouping, same constants: one source.
 */
export function anchorWordBudgets(
  entries: ActionEntry[],
  durationMs: number
): { intro: number; outro: number; perAction: Map<number, number> } {
  const o = edl.EDL_DEFAULTS
  const words = (ms: number) =>
    Math.max(1, Math.floor((ms - o.segmentGapMs) / MS_PER_WORD))
  const perAction = new Map<number, number>()
  let prevEnd = 0
  for (const g of edl.groupActions(entries, o.mergeGapMs)) {
    const start = Math.min(
      Math.max(g.startMs - o.preRollMs, prevEnd),
      durationMs
    )
    const end = Math.min(
      Math.max(g.endMs + o.postRollMs, start + 1),
      durationMs
    )
    prevEnd = end
    // The whole group shares one window; budget it on the first action,
    // which is where the prompt tells the narrator to anchor a burst.
    perAction.set(g.actionIdxs[0], words(end - start))
    for (const idx of g.actionIdxs.slice(1)) perAction.set(idx, 0)
  }
  // Intro and outro play over a deliberate still — the opening frame, the
  // final state — so a hold there is a design choice, not a defect, and
  // can run to about twice the minimum before it reads as a stall. Action
  // anchors get no such slack: a hold there is a frozen cursor mid-click.
  const still = 2 * o.minHoldMs
  return { intro: words(still), outro: words(still), perAction }
}

// Wire schema for the narrator's structured output — kept free of
// minItems/maxItems/minimum JSON-schema keywords (no .min()/.max()/.int() on
// the array or the numeric anchor branch). Mastra passes this schema
// natively via response_format, and strict `json_schema` providers (e.g.
// @ai-sdk/openai's default) reject those constraint keywords outright,
// which would hard-fail the whole run at narrate — AFTER every scene is
// already recorded. Segment-count guidance ("2-6 segments per scene") lives
// in NARRATOR_INSTRUCTIONS prose instead. Downstream is safe with unbounded/
// non-integer anchors: `buildEdl` clamps out-of-range or non-integer action
// indices to the last action group, and `ttsStep`'s
// `segments.length === 0` guard now also covers the case where the array
// itself validates as empty.
export const segmentAnchorSchema = z.union([
  z.literal("intro"),
  z.literal("outro"),
  z.number(),
])
export type SegmentAnchor = z.infer<typeof segmentAnchorSchema>

export const narrationSegmentsSchema = z.object({
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      segments: z.array(
        z.object({
          text: z.string().describe("One short spoken sentence"),
          anchor: segmentAnchorSchema.describe(
            'What this line plays over: "intro" (opening frame, before any action), ' +
              'an action index from the numbered action list, or "outro" (final state)'
          ),
        })
      ),
    })
  ),
})
export type NarrationSegments = z.infer<typeof narrationSegmentsSchema>

export const NARRATOR_INSTRUCTIONS = `You are the Demio narrator. You write voiceover narration for a recorded product demo, given each scene's goal, narration hint, and a numbered list of the browser actions the recorder performed.

Rules:
- Each segment is { text, anchor }. You NEVER schedule times — the sync engine times everything. anchor says what the line plays over:
  - "intro" — over the scene's opening frame, before any action happens. Use it to set context.
  - an action index (a number from the scene's numbered action list) — the line plays as that action happens on screen.
  - "outro" — over the scene's final state. Use it to land the outcome.
- List segments in playback order: intro lines first, then action-anchored lines in ascending action order, outro lines last. Multiple lines may share an anchor.
- One short conversational sentence per segment, at ~${NARRATION_WORDS_PER_MINUTE} words per minute. Match each scene's narrationHint for tone.
- **Every anchor carries a word budget** — \`intro (≤4 words)\`, \`2: click … (≤6 words)\` — which is how much speech the footage under it can carry. A line longer than its budget freezes the video on a cloned frame for the overrun; the viewer sees a still. Stay within the budget of every anchor you use. An anchor with a budget of 0 belongs to a burst — anchor that line to the burst's first action instead.
- Fewer, shorter lines beat more. A short scene gets one line, or none beyond an intro. Never pad to a count. An action marked "too brief to narrate" gets no line — let the intro or outro carry the scene.
- Anchor to the FIRST action of a burst: typing then pressing Enter is one moment — anchor to the typing action's index.
- Output narration for every scene provided. 1-6 segments per scene.`

/** What the narrator is told about one scene. */
export interface NarratorScene {
  sceneId: string
  goal: string
  narrationHint?: string
  /** Length of the recorded take, in seconds. */
  durationSec: number
  /** `"<idx>: <action> <args>"`, one per recorded action, in order. */
  numberedActions: string[]
  /** The recorded timeline, when known — used to budget each anchor. */
  actionEntries?: ActionEntry[]
}

export interface NarrateInput {
  workspace: string
  modelId: string
  demoTitle: string
  scenes: NarratorScene[]
  signal?: AbortSignal
}

export interface NarrateResult {
  /** `undefined` when the model's output did not parse — the caller decides. */
  narration: NarrationSegments | undefined
  steps: unknown[]
  usage: unknown
}

export async function narrateScenes(
  input: NarrateInput
): Promise<NarrateResult> {
  // Narrator needs no tools — action logs are inlined into the prompt.
  const narrator = createDemioAgent({
    workspace: input.workspace,
    modelId: input.modelId,
    toolFilter: [],
    instructionsOverride: NARRATOR_INSTRUCTIONS,
  })
  const run = await narrator.generate(
    `Write voiceover narration for this demo: ${input.demoTitle}.
Scene data (goals, hints, numbered action lists):
${JSON.stringify(
  input.scenes.map((s) => {
    const budgets = anchorWordBudgets(
      s.actionEntries ?? [],
      Math.round(s.durationSec * 1000)
    )
    return {
      sceneId: s.sceneId,
      goal: s.goal,
      narrationHint: s.narrationHint,
      actions: {
        sceneId: s.sceneId,
        durationSec: s.durationSec,
        intro: `≤${budgets.intro} words`,
        outro: `≤${budgets.outro} words`,
        numberedActions: s.numberedActions.map((line, i) => {
          const b = budgets.perAction.get(i)
          if (b === undefined) return line
          // Under three words there is no sentence to write; say so
          // rather than inviting a two-word fragment.
          return b < 3
            ? `${line} (too brief to narrate)`
            : `${line} (≤${b} words)`
        }),
      },
    }
  }),
  null,
  2
)}`,
    {
      structuredOutput: { schema: narrationSegmentsSchema },
      abortSignal: input.signal,
    }
  )
  return {
    narration: run.object as NarrationSegments | undefined,
    steps: (run.steps ?? []) as unknown[],
    usage: run.usage,
  }
}
