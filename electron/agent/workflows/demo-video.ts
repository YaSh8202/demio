// ── demo-video workflow (ADR-001) ───────────────────────────────────────────
//
// plan (input) → foreach scene [record+verify+retry, suspend on exhaustion]
// → collect → narrate (structured) → tts (skipped when no voice) → compose
// (ffmpeg).
//
// Reconciled against installed `@mastra/core@1.55.0` workflow/agent APIs
// (Task 12) — see `task-12-report.md` for full evidence. The two load-bearing
// deviations from the task-12-brief's starting code:
//
// 1. **Suspend/resume is snapshot-replay, not an in-place await.** Per the
//    installed docs (`node_modules/@mastra/core/dist/docs/references/
//    docs-workflows-suspend-and-resume.md`): "When a workflow is suspended,
//    it restarts from the step where it paused" — resuming RE-INVOKES the
//    suspended step's `execute` from the top, with `resumeData` populated,
//    rather than resolving the original `await suspend(...)` call in place.
//    The canonical pattern reads `resumeData` at the top of `execute` and
//    only calls `suspend()` again if the condition still isn't met — it does
//    NOT use `suspend()`'s return value as the decision (the brief's
//    `recordScenesStep` did exactly that, which is wrong here).
//
//    Given that, a single step containing a `for` loop over every scene
//    (the brief's `recordScenesStep`) is unsafe: resuming it would re-run
//    the loop from scene 0, re-recording every already-completed scene.
//    Fixed by using `.foreach(sceneStep, { concurrency: 1 })` instead — the
//    docs confirm foreach iterations "suspend independently" and a resume
//    only re-invokes the ONE suspended iteration's step
//    (`reference-workflows-workflow-methods-foreach.md`, "Resuming a single
//    iteration"). `concurrency: 1` (default) preserves the sequential
//    continuity contract the brief's manual loop was going for.
//
// 2. **`suspend`/`resumeData` come from `createStep`'s own
//    `suspendSchema`/`resumeSchema` fields**, not an inline
//    `suspend({ suspendSchema, resumeSchema, suspendData })` call —
//    confirmed via `ExecuteFunctionParams` in
//    `agentcontroller-api-notes.md`: `suspend: (suspendPayload?,
//    suspendOptions?) => ...` takes a single payload, not a schema-bearing
//    options object.

import { createWorkflow, createStep } from "@mastra/core/workflows"
import { promises as fs } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { scenePlanSchema, sceneResultSchema, sceneSchema } from "./schemas"
import type { SceneResult } from "./schemas"
import { recordSceneWithRetry } from "./record-scene"
import { synthesizeSegments } from "../lib/voiceover"
import { createDemioAgent } from "../demio-agent"
import { parseActionEntries } from "./sync"
import { resolveFfmpeg } from "../../lib/ffmpeg"
import { getDecryptedKey } from "../../store/provider-keys"

const execFileAsync = promisify(execFile)

// `elevenLabsKey` is deliberately NOT part of this schema (code review fix
// #4): `createRun`/`start`/`resume` snapshot `inputData` into the workflow's
// LibSQLStore row on every suspend, and a decrypted API key has no business
// sitting in that table in plaintext. `voiceId` alone travels through the
// pipeline; `ttsStep` re-reads `getDecryptedKey("elevenlabs")` at the moment
// it actually needs the key, off the same on-disk encrypted store
// `controller.ts` already reads it from.
const inputSchema = z.object({
  plan: scenePlanSchema,
  workspace: z.string(),
  modelId: z.string(),
  voiceId: z.string().nullable(),
})

/** Data every scene-level step needs but doesn't receive as its per-item
 * `inputData` once scenes are inside `.foreach()` — recovered via
 * `getInitData()` instead of being threaded through the array. */
type DemoVideoInit = z.infer<typeof inputSchema>

// `sceneSchema.id` only carries a `.describe()` hint ("Stable slug, e.g.
// scene-01") — no `.regex()` — so a malformed/adversarial plan could smuggle
// path-traversal characters (`../`, `/`) or shell-unsafe characters into a
// sceneId. Every downstream sceneId use ends up in a `path.join(...)` (this
// file's `composeStep` normalization, and internally inside
// `synthesizeSegments` for the voiced-segment paths) — validate once, here,
// at the earliest choke point, so every one of those sites is safe by
// construction rather than needing its own guard (code review round-2 #6).
const SAFE_SCENE_ID = /^[a-zA-Z0-9._-]+$/

const toScenesStep = createStep({
  id: "to-scenes",
  inputSchema,
  outputSchema: z.array(sceneSchema),
  execute: async ({ inputData }) => {
    for (const scene of inputData.plan.scenes) {
      if (!SAFE_SCENE_ID.test(scene.id)) {
        throw new Error(
          `generate_demo: scene id "${scene.id}" is not a safe filename slug ` +
            `(must match ${SAFE_SCENE_ID})`
        )
      }
    }
    return inputData.plan.scenes
  },
})

const sceneResumeSchema = z.object({
  action: z.enum(["retry", "skip", "abort"]),
  guidance: z.string().optional(),
})
const sceneSuspendSchema = z.object({
  sceneId: z.string(),
  failure: z.string(),
  attempts: z.number(),
})

/**
 * Records (and mechanically verifies) exactly one scene, with the harness's
 * own internal retry loop (`recordSceneWithRetry`, up to its own
 * `maxAttempts`). Only suspends the WORKFLOW once that internal retry budget
 * is exhausted, asking the user to retry (optionally with guidance folded
 * into the next attempt's actions), skip this scene, or abort the whole run.
 *
 * Returns `null` for a skipped scene — filtered out by `collectResultsStep`.
 */
const sceneStep = createStep({
  id: "record-scene",
  inputSchema: sceneSchema,
  outputSchema: sceneResultSchema.nullable(),
  resumeSchema: sceneResumeSchema,
  suspendSchema: sceneSuspendSchema,
  execute: async ({ inputData: scene, resumeData, suspend, getInitData, writer, abortSignal }) => {
    const init = getInitData<DemoVideoInit>()

    // Re-invoked from the top on resume (see file header) — resumeData is
    // only populated on that replay pass, so a fresh first pass falls
    // through to recording unconditionally.
    if (resumeData?.action === "abort") {
      throw new Error(`Demo generation aborted at scene ${scene.id} by user`)
    }
    if (resumeData?.action === "skip") {
      return null
    }

    const sceneToRecord =
      resumeData?.action === "retry" && resumeData.guidance
        ? { ...scene, actions: [...scene.actions, `User guidance: ${resumeData.guidance}`] }
        : scene

    const outcome = await recordSceneWithRetry({
      scene: sceneToRecord,
      workspace: init.workspace,
      modelId: init.modelId,
      signal: abortSignal,
      onProgress: (u) => {
        void writer.write({ type: "scene-progress", ...u, of: init.plan.scenes.length })
      },
    })

    if (outcome.status === "done") return outcome.result

    return await suspend({
      sceneId: scene.id,
      failure: outcome.lastReport.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; "),
      attempts: outcome.attempts,
    })
  },
})

// Explicit intermediate schemas (rather than chaining `.extend()` off a
// `Step.outputSchema`) — `createStep` exposes `outputSchema` typed as
// `StandardSchemaWithJSON<...>`, which drops the zod-specific `.extend`
// method even though the runtime value is still the same zod object. Each
// schema below is built from a plain zod variable instead, and reused as
// both the producing step's `outputSchema` and the next step's
// `inputSchema` so the two stay structurally identical.
const collectedSchema = inputSchema.extend({ results: z.array(sceneResultSchema) })

const collectResultsStep = createStep({
  id: "collect-scene-results",
  inputSchema: z.array(sceneResultSchema.nullable()),
  outputSchema: collectedSchema,
  execute: async ({ inputData, getInitData }) => {
    const init = getInitData<DemoVideoInit>()
    const results = inputData.filter((r): r is SceneResult => r !== null)
    return { ...init, results }
  },
})

const segmentAnchorSchema = z.union([
  z.literal("intro"),
  z.literal("outro"),
  z.number().int().min(0),
])

const narrationSegmentsSchema = z.object({
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      segments: z
        .array(
          z.object({
            text: z.string().describe("One short spoken sentence"),
            anchor: segmentAnchorSchema.describe(
              'What this line plays over: "intro" (opening frame, before any action), ' +
                'an action index from the numbered action list, or "outro" (final state)'
            ),
          })
        )
        .min(1)
        .max(8),
    })
  ),
})

const narratedSchema = collectedSchema.extend({
  narration: narrationSegmentsSchema.nullable(),
})

const NARRATOR_INSTRUCTIONS = `You are the Demio narrator. You write voiceover narration for a recorded product demo, given each scene's goal, narration hint, and a numbered list of the browser actions the recorder performed.

Rules:
- Each segment is { text, anchor }. You NEVER schedule times — the sync engine times everything. anchor says what the line plays over:
  - "intro" — over the scene's opening frame, before any action happens. Use it to set context.
  - an action index (a number from the scene's numbered action list) — the line plays as that action happens on screen.
  - "outro" — over the scene's final state. Use it to land the outcome.
- List segments in playback order: intro lines first, then action-anchored lines in ascending action order, outro lines last. Multiple lines may share an anchor.
- One short conversational sentence per segment (~150 words per minute pacing — a sentence of 8-15 words). Match each scene's narrationHint for tone.
- Anchor to the FIRST action of a burst: typing then pressing Enter is one moment — anchor to the typing action's index.
- Output narration for every scene provided, even if brief. 2-6 segments per scene.`

const narrateStep = createStep({
  id: "narrate",
  inputSchema: collectedSchema,
  outputSchema: narratedSchema,
  execute: async ({ inputData, abortSignal }) => {
    // Code review round-2 #2: gate on key AVAILABILITY too, not just
    // `voiceId` — the key itself still never enters workflow input/state
    // (see `inputSchema`'s comment), only this boolean check does. Without
    // this, a voice configured with a missing/revoked key used to record
    // every scene and only THEN hard-fail in `ttsStep` — degrading to an
    // unvoiced video (the pre-fix-round-1 behavior) here instead skips the
    // wasted narration call and matches what `ttsStep` now also degrades to.
    if (!inputData.voiceId || !getDecryptedKey("elevenlabs")) {
      return { ...inputData, narration: null }
    }
    // Narrator needs no tools — action logs are inlined into the prompt.
    const narrator = createDemioAgent({
      workspace: inputData.workspace,
      signal: abortSignal,
      modelId: inputData.modelId,
      toolFilter: [],
      instructionsOverride: NARRATOR_INSTRUCTIONS,
    })
    const actionLogs = await Promise.all(
      inputData.results.map(async (r) => {
        const entries = parseActionEntries(await fs.readFile(r.actionsPath, "utf8"))
        return {
          sceneId: r.sceneId,
          durationSec: r.durationSec,
          numberedActions: entries.map(
            (e) => `${e.idx}: ${e.action}${e.argsSummary ? ` ${e.argsSummary}` : ""}`
          ),
        }
      })
    )
    const { object } = await narrator.generate(
      `Write voiceover narration for this demo: ${inputData.plan.demoTitle}.
Scene data (goals, hints, numbered action lists):
${JSON.stringify(
  inputData.plan.scenes.map((s) => ({
    sceneId: s.id,
    goal: s.goal,
    narrationHint: s.narrationHint,
    actions: actionLogs.find((l) => l.sceneId === s.id),
  })),
  null,
  2
)}`,
      { structuredOutput: { schema: narrationSegmentsSchema }, abortSignal }
    )
    return { ...inputData, narration: object }
  },
})

const voicedSchema = narratedSchema.extend({
  voicedPaths: z.record(z.string(), z.string()).nullable(),
})

const ttsStep = createStep({
  id: "tts",
  inputSchema: narratedSchema,
  outputSchema: voicedSchema,
  execute: async ({ inputData, abortSignal }) => {
    if (!inputData.narration || !inputData.voiceId) {
      return { ...inputData, voicedPaths: null }
    }

    // Re-read the decrypted key here rather than threading it through
    // `inputData` (code review fix #4) — see the `inputSchema` comment for
    // why it must not ride the persisted workflow snapshot. `narrateStep`
    // already gates on the same check before generating narration, so this
    // should always be present by the time `ttsStep` runs — but the key
    // could theoretically be deleted/revoked in the window between the two
    // steps. Degrade to unvoiced (round-2 #2) rather than hard-failing the
    // whole run after every scene has already been recorded: a video the
    // user can still watch beats no video at all over a key that went away
    // mid-run.
    const elevenLabsKey = getDecryptedKey("elevenlabs")
    if (!elevenLabsKey) {
      return { ...inputData, voicedPaths: null }
    }

    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) {
      // Fail loudly rather than silently shipping an unvoiced video when the
      // user configured a voice — `resolveFfmpeg` returns `string | null`.
      throw new Error(
        "ffmpeg binary not available — cannot mix voiceover onto the scene video. " +
          "Reinstall dependencies, or remove the project's voice to skip narration."
      )
    }

    const voicedPaths: Record<string, string> = {}
    for (const sceneNarration of inputData.narration.scenes) {
      // Ledgered gap (lib/voiceover.ts): `synthesizeSegments` builds an
      // invalid `amix=inputs=0` filter on an empty segment list — skip this
      // scene's tts instead of calling it.
      if (sceneNarration.segments.length === 0) continue

      const result = inputData.results.find((r) => r.sceneId === sceneNarration.sceneId)
      if (!result) continue

      const synth = await synthesizeSegments({
        cwd: inputData.workspace,
        sceneId: sceneNarration.sceneId,
        sceneVideoPath: result.videoPath,
        segments: sceneNarration.segments,
        voiceId: inputData.voiceId,
        apiKey: elevenLabsKey,
        signal: abortSignal,
      })
      // `segmentPaths`/`outputPath` from `synthesizeSegments` are
      // workspace-relative (lib/voiceover.ts) — run the mix with `cwd` set
      // to the workspace so those relative -i/output args resolve, and
      // store the ABSOLUTE output path so `composeStep`'s concat list is
      // consistent with the unvoiced branch's absolute `SceneResult.videoPath`.
      await execFileAsync(ffmpeg, synth.ffmpegMixArgs, { cwd: inputData.workspace })
      voicedPaths[sceneNarration.sceneId] = path.join(inputData.workspace, synth.outputPath)
    }
    return { ...inputData, voicedPaths }
  },
})

const composeStep = createStep({
  id: "compose",
  inputSchema: voicedSchema,
  outputSchema: z.object({
    videoPath: z.string(),
    scenes: z.array(sceneResultSchema),
  }),
  execute: async ({ inputData }) => {
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) {
      throw new Error(
        "ffmpeg binary not available — cannot compose the final demo video."
      )
    }

    const outDir = path.join(inputData.workspace, "output")
    await fs.mkdir(outDir, { recursive: true })

    // Normalize every scene to a uniform h264/yuv420p/30fps + aac .mp4
    // BEFORE concatenating (code review fix #6). A run's scenes are a mix
    // of raw .webm (whatever codec agent-browser recorded, video-only) and
    // voiced .mp4 (already h264/yuv420p/30fps/aac — see `ttsStep`'s
    // `buildFfmpegMixArgs` output). The concat DEMUXER (`-f concat`) only
    // works correctly when every input shares the same codec/container —
    // `-c copy` outright fails on a codec mismatch, and re-encoding via the
    // demuxer (`-c:v libx264` with mixed inputs) is not a substitute: the
    // demuxer itself requires uniform inputs to decode correctly in the
    // first place. Normalizing each part individually first (a plain
    // single-input transcode, safe regardless of source codec) means the
    // final concat is ALWAYS a uniform `-c copy`, sidestepping the demuxer's
    // uniformity requirement entirely rather than trying to pick a
    // concat-filter workaround per mix.
    const parts: string[] = []
    for (const r of inputData.results) {
      const voicedPath = inputData.voicedPaths?.[r.sceneId]
      if (voicedPath) {
        parts.push(voicedPath)
        continue
      }
      // Raw scene recordings are video-only (the voiceover pipeline never
      // copies original recording audio either — see `ttsStep`'s `-map
      // 0:v` — so a missing/ignored source audio track is consistent
      // behavior, not a regression). Synthesize a silent audio track sized
      // to the video via `-shortest` against an infinite `anullsrc` so the
      // normalized output has the same stream layout (1 video + 1 audio)
      // as a voiced part, matching the concat demuxer's requirements.
      const normalizedPath = path.join(outDir, `${r.sceneId}.normalized.mp4`)
      await execFileAsync(ffmpeg, [
        "-y",
        "-i",
        r.videoPath,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-shortest",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-c:a",
        "aac",
        // Pin the audio format explicitly (code review round-2 #5) rather
        // than relying on the AAC encoder inferring it from the `anullsrc`
        // source — the final concat is a stream COPY (`-c copy` below), so
        // every part's audio must already match exactly; an implicit
        // sample-rate/channel mismatch against `ttsStep`'s voiced output
        // would only surface as a broken/silent-audio concat downstream.
        "-ar",
        "44100",
        "-ac",
        "2",
        normalizedPath,
      ])
      parts.push(normalizedPath)
    }

    const outputPath = path.join(outDir, "demo.mp4")
    const listPath = path.join(outDir, "concat.txt")
    await fs.writeFile(
      listPath,
      parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n")
    )
    await execFileAsync(ffmpeg, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ])
    return { videoPath: outputPath, scenes: inputData.results }
  },
})

export const demoVideoWorkflow = createWorkflow({
  id: "demo-video",
  inputSchema,
  outputSchema: composeStep.outputSchema,
})
  .then(toScenesStep)
  .foreach(sceneStep, { concurrency: 1 })
  .then(collectResultsStep)
  .then(narrateStep)
  .then(ttsStep)
  .then(composeStep)
  .commit()
