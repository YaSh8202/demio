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

const toScenesStep = createStep({
  id: "to-scenes",
  inputSchema,
  outputSchema: z.array(sceneSchema),
  execute: async ({ inputData }) => inputData.plan.scenes,
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

const narrationSegmentsSchema = z.object({
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      segments: z.array(z.object({ text: z.string(), atSec: z.number() })),
    })
  ),
})

const narratedSchema = collectedSchema.extend({
  narration: narrationSegmentsSchema.nullable(),
})

const NARRATOR_INSTRUCTIONS = `You are the Demio narrator. You write voiceover narration for a recorded product demo, given each scene's goal, narration hint, and a timed log of the actions the recorder performed.

Rules:
- Target ~150 words per minute (~2.5 words/second).
- 2-6 timed segments per scene. Each segment is { text, atSec } — atSec is seconds from the scene's own recording start.
- No segment may start later than that scene's durationSec - 2.
- Segments within a scene must not overlap: segment N+1's atSec must be at least the estimated duration of segment N after segment N's atSec.
- Schedule a line slightly BEFORE the action it describes (0.6-1.2s lead-in) — viewers should hear "now we'll log in" just before the click lands.
- Write in a natural, conversational register matching each scene's narrationHint. Keep each segment to one short sentence.
- Output narration for every scene provided, even if brief.`

const narrateStep = createStep({
  id: "narrate",
  inputSchema: collectedSchema,
  outputSchema: narratedSchema,
  execute: async ({ inputData, abortSignal }) => {
    if (!inputData.voiceId) {
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
      inputData.results.map(async (r) => ({
        sceneId: r.sceneId,
        durationSec: r.durationSec,
        actions: await fs.readFile(r.actionsPath, "utf8"),
      }))
    )
    const { object } = await narrator.generate(
      `Write voiceover narration for this demo: ${inputData.plan.demoTitle}.
Scene data (goals, hints, timed action logs):
${JSON.stringify(
  inputData.plan.scenes.map((s) => ({
    sceneId: s.id,
    goal: s.goal,
    narrationHint: s.narrationHint,
    log: actionLogs.find((l) => l.sceneId === s.id),
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
    // why it must not ride the persisted workflow snapshot.
    const elevenLabsKey = getDecryptedKey("elevenlabs")
    if (!elevenLabsKey) {
      throw new Error(
        `generate_demo: project has voiceId "${inputData.voiceId}" configured but no ` +
          "ElevenLabs API key is stored — cannot synthesize voiceover."
      )
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
