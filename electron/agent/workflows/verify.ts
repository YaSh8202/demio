// ── Scene artifact verification ──────────────────────────────────────────────
//
// Verification checks the FILE, not the process. Whether every step ran and
// asserted clean is known by the replay engine in real time (see replay.ts)
// and acted on immediately — re-deriving it from the action log afterwards
// would be asking the same question from worse evidence.
//
// Replaces the old four checks: `actions-ok` and `end-url` moved into replay
// as per-step assertions, and `duration-range` became a computed check now
// that a take's length is predictable (the old planner-guessed range had to
// be clamped up to 120s because raw recordings carried LLM think-time).

import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { peakVolumeDb, probeArtifact } from "./artifact"
import { expectedDurationMs } from "./replay"
import type { SceneScript } from "./script-schema"
import type { VerifyReport } from "./schemas"

const require = createRequire(import.meta.url)

const pure = require("./artifact-pure.cjs") as {
  checkBlackFrames: (
    spans: Array<{ durationSec: number }>,
    videoDurationSec: number
  ) => { ok: boolean; detail: string }
  checkComputedDuration: (
    actualSec: number,
    expectedSec: number,
    tolerance?: number
  ) => { ok: boolean; detail: string }
}

export interface VerifyInput {
  script: SceneScript
  videoPath: string
  /** True when a voice is configured, so a missing audio track is a defect. */
  voiceExpected: boolean
}

export async function verifyScene(input: VerifyInput): Promise<VerifyReport> {
  const checks: VerifyReport["checks"] = []

  let exists = false
  try {
    const stat = await fs.stat(input.videoPath)
    exists = stat.size > 0
  } catch {
    exists = false
  }
  checks.push({
    name: "video-exists",
    ok: exists,
    detail: exists ? input.videoPath : `missing or empty: ${input.videoPath}`,
  })

  if (!exists) {
    for (const name of [
      "duration-range",
      "black-frames",
      "freeze-frames",
    ] as const) {
      checks.push({ name, ok: false, detail: "skipped: no video" })
    }
    return { ok: false, checks }
  }

  try {
    const probe = await probeArtifact(input.videoPath)

    const dur = pure.checkComputedDuration(
      probe.durationSec,
      expectedDurationMs(input.script) / 1000
    )
    checks.push({ name: "duration-range", ok: dur.ok, detail: dur.detail })

    const black = pure.checkBlackFrames(probe.blackSpans, probe.durationSec)
    checks.push({ name: "black-frames", ok: black.ok, detail: black.detail })

    // Informational: a deterministic dwell on a settled page is a static
    // image but not a defect, so a freeze never fails the scene on its own.
    // It is surfaced so a human reviewing a bad take can see it.
    checks.push({
      name: "freeze-frames",
      ok: true,
      detail:
        probe.freezeSpans.length === 0
          ? "no freezes over 4s"
          : `${probe.freezeSpans.length} freeze span(s) over 4s: ` +
            probe.freezeSpans
              .map((f) =>
                f.open
                  ? `${f.startSec.toFixed(1)}s — still frozen at end of recording`
                  : `${f.startSec.toFixed(1)}s for ${f.durationSec.toFixed(1)}s`
              )
              .join(", "),
    })

    if (input.voiceExpected) {
      checks.push({
        name: "audio-track",
        ok: probe.hasAudio,
        detail: probe.hasAudio
          ? "audio track present"
          : "a voice was configured but the recording has no audio track",
      })
    }
  } catch (err) {
    checks.push({
      name: "duration-range",
      ok: false,
      detail: `could not probe: ${(err as Error).message}`,
    })
  }

  return { ok: checks.every((c) => c.ok), checks }
}

/**
 * The same file-level checks, on the composed `output/demo.mp4`. Every scene
 * was verified on its way in; nothing looked at what came out — a compose that
 * dropped footage, or a voiced run that lost its audio in the concat, read as
 * a clean run.
 */
/** A final video this much shorter than its scenes lost footage in compose. */
const MIN_FINAL_TO_SCENES_RATIO = 0.5
/** Peak level at or below this is silence (digital silence is about -91 dB). */
const SILENCE_PEAK_DB = -60

export async function verifyFinalVideo(input: {
  videoPath: string
  /** Sum of the scenes' own durations — the final cut is retimed, so this is a floor, not a target. */
  scenesDurationSec: number
  voiced: boolean
  minRatio?: number
}): Promise<{
  ok: boolean
  durationSec: number
  checks: VerifyReport["checks"]
}> {
  const checks: VerifyReport["checks"] = []
  let durationSec = 0
  try {
    const size = await fs
      .stat(input.videoPath)
      .then((stat) => stat.size)
      .catch(() => 0)
    checks.push({
      name: "video-exists",
      ok: size > 0,
      detail:
        size > 0 ? input.videoPath : `missing or empty: ${input.videoPath}`,
    })
    if (size === 0) return { ok: false, durationSec, checks }
    const probe = await probeArtifact(input.videoPath)
    durationSec = probe.durationSec
    const floorSec =
      input.scenesDurationSec * (input.minRatio ?? MIN_FINAL_TO_SCENES_RATIO)
    checks.push({
      name: "duration-range",
      ok: probe.durationSec >= Math.max(1, floorSec),
      detail: `duration ${probe.durationSec.toFixed(1)}s, scenes total ${input.scenesDurationSec.toFixed(1)}s`,
    })
    const black = pure.checkBlackFrames(probe.blackSpans, probe.durationSec)
    checks.push({ name: "black-frames", ok: black.ok, detail: black.detail })
    if (input.voiced) {
      // Not `probe.hasAudio`: every part carries a silent track, so a stream
      // is always there. What a voiced run can lose is the voice.
      const peak = await peakVolumeDb(input.videoPath)
      const audible = peak !== null && peak > SILENCE_PEAK_DB
      checks.push({
        name: "audio-track",
        ok: audible,
        detail: audible
          ? `voice present (peak ${peak.toFixed(1)} dB)`
          : `the run was voiced but the final video is silent (peak ${peak === null ? "unmeasurable" : `${peak} dB`})`,
      })
    }
  } catch (err) {
    // The file is there (checked above) — what failed is reading it.
    checks.push({
      name: "duration-range",
      ok: false,
      detail: `could not probe: ${(err as Error).message}`,
    })
  }
  return { ok: checks.every((c) => c.ok), durationSec, checks }
}
