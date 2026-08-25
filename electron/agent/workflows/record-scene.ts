// ── Record-scene step (ADR-003, ADR-005) ────────────────────────────────────
//
// Harness owns the recording lifecycle: open start URL (or continue on the
// live page for a chained scene), replay the scene's script deterministically,
// stop recording, mechanically verify. Up to `maxAttempts` (default 3)
// attempts. Replay is deterministic, so a plain retry repeats the same
// script byte-for-byte — the only thing that changes attempt-to-attempt is
// a mid-take deviation triggering off-camera recovery (recovery.ts) before
// the retake. `previousFailure` never changes what a later attempt does —
// diagnostic only, surfacing via the per-attempt transcript, the log,
// progress events, and the synthesized failure report.
//
// Reconciled against installed APIs (Task 11):
// - `record start <path> [url] [flags]` accepts `--log-actions <path>`
//   (confirmed via `agent-browser record --help`). `recordingBracket` in
//   `replay-pure.cjs` builds the exact `open`/`record start`/`record
//   restart` commands issued below.

import path from "node:path"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import { replayScene } from "./replay"
import { recoverFromDeviation } from "./recovery"
import { verifyScene } from "./verify"
import type { Scene, SceneResult, VerifyReport } from "./schemas"
import type { SceneScript } from "./script-schema"
import log from "../../lib/logger"

const require = createRequire(import.meta.url)
const pure = require("./replay-pure.cjs") as {
  recordingBracket: (o: {
    script: SceneScript
    videoPath: string
    actionsPath: string
    isRetry: boolean
  }) => { commands: string[]; resetsPage: boolean }
}

const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Persist a debug artifact for one recording attempt.
 *
 * Replay is a bare deterministic run — no agent, no memory, no threadId —
 * so nothing about a given attempt reaches `mastra_messages` and it is
 * otherwise invisible after the run. We write the replay outcome (and the
 * failure context that led into it) next to the scene's other artifacts
 * (`<sceneId>.webm`, `<sceneId>.actions.jsonl`).
 *
 * Best-effort by construction: a failure to write a debug artifact must never
 * fail the scene that produced it.
 */
async function writeAgentTranscript(
  filePath: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8")
  } catch (err) {
    log.warn(
      `[demo-workflow] could not write agent transcript ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

/**
 * Synthesize a VerifyReport for a failure that happened before (or instead
 * of) mechanical verification: the recording bracket failed to open or
 * start, replay was aborted mid-take, or replay hit a deviation that
 * recovery could not clear (the take is abandoned before `verifyScene` ever
 * runs in that case). Without this, those paths would return
 * `{ ok: false, checks: [] }` — no diagnostic at all for the caller.
 */
function infraFailureReport(detail: string): VerifyReport {
  return { ok: false, checks: [{ name: "video-exists", ok: false, detail }] }
}

export async function recordSceneWithRetry(opts: {
  scene: Scene
  workspace: string
  modelId: string
  voiceExpected: boolean
  /**
   * Free-text hint the user typed when resuming a suspended scene with
   * "retry". Forwarded to the off-camera recovery agent as advisory
   * context, not consumed anywhere else — replay itself is deterministic
   * and has no concept of a hint.
   */
  guidance?: string
  signal: AbortSignal
  maxAttempts?: number
  onProgress?: (u: {
    sceneId: string
    attempt: number
    phase: "recording" | "verifying" | "failed" | "done"
    detail?: string
  }) => void
}): Promise<
  | { status: "done"; result: SceneResult }
  | { status: "failed"; lastReport: VerifyReport; attempts: number }
> {
  const { scene, workspace, modelId, signal } = opts
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  let lastReport: VerifyReport = { ok: false, checks: [] }
  let previousFailure = ""
  // Attempts *started*, not `maxAttempts` — an abort before attempt 1 (or
  // between attempts) must not be reported as if all `maxAttempts` ran.
  let attemptsMade = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) break
    attemptsMade = attempt
    const videoPath = path.join(workspace, "scenes", `${scene.id}.webm`)
    const actionsPath = path.join(
      workspace,
      "scenes",
      `${scene.id}.actions.jsonl`
    )
    const transcriptPath = path.join(
      workspace,
      "scenes",
      `${scene.id}.attempt-${attempt}.agent.json`
    )

    const script = scene.script
    if (!script) {
      // Until rehearsal ships (plan 2), a scene without a script cannot be
      // recorded. Fail loudly rather than silently falling back to the
      // deleted recorder agent.
      return {
        status: "failed",
        lastReport: infraFailureReport(
          `scene ${scene.id} has no script — the record pass requires one`
        ),
        attempts: attemptsMade,
      }
    }

    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "recording" })

    // 1. Open the take. A chained scene restarts on the live page; an
    //    independent scene (or any retry) re-opens the start URL.
    const bracket = pure.recordingBracket({
      script,
      videoPath,
      actionsPath,
      isRetry: attempt > 1,
    })
    // NOTE: execAgentBrowser takes ONE FULL COMMAND STRING per array
    // element — a single-element array is tokenized as one command, but a
    // multi-element array switches to `batch` mode, where `wrapBatchArgs`
    // escapes `\` and `"` but NOT `'`. `recordingBracket` single-quotes its
    // paths and URLs, and exec.ts spawns with no shell to strip them en
    // route — so each bracket command MUST be issued as its own
    // single-element call, never batched into one.
    let bracketFailed = false
    for (const cmd of bracket.commands) {
      const r = await execAgentBrowser([cmd], { timeout: 60_000 })
      if (!r.ok) {
        // A stale recording session is the known failure mode — clear it.
        await execAgentBrowser(["record stop"], { timeout: 15_000 })
        previousFailure = `failed before recording — \`${cmd}\` failed: ${r.error ?? "unknown error"}`
        lastReport = infraFailureReport(previousFailure)
        bracketFailed = true
        break
      }
    }
    if (bracketFailed) {
      log.warn(
        `[demo-workflow] scene ${scene.id} attempt ${attempt} ${previousFailure}`
      )
      opts.onProgress?.({
        sceneId: scene.id,
        attempt,
        phase: "failed",
        detail: previousFailure,
      })
      continue
    }

    // 2. Deterministic replay. No LLM on the happy path.
    const outcome = await replayScene({
      script,
      signal,
      onStep: (step) =>
        opts.onProgress?.({
          sceneId: scene.id,
          attempt,
          phase: "recording",
          detail: `step ${step.index + 1}/${script.actions.length}: ${step.cmd}`,
        }),
    })

    // 3. Recording ALWAYS stops before anything else happens.
    const stop = await execAgentBrowser(["record stop"], { timeout: 30_000 })
    if (!stop.ok) {
      log.warn(
        `[demo-workflow] scene ${scene.id} attempt ${attempt} record stop failed: ${stop.error}`
      )
    }

    await writeAgentTranscript(transcriptPath, {
      sceneId: scene.id,
      attempt,
      modelId,
      previousFailure: previousFailure || null,
      replay: outcome,
    })

    if (outcome.status === "aborted") {
      previousFailure = `aborted mid-replay after ${outcome.steps.length} step(s)`
      lastReport = infraFailureReport(previousFailure)
      log.warn(
        `[demo-workflow] scene ${scene.id} attempt ${attempt} ${previousFailure}`
      )
      break
    }

    // 4. Deviation: recover with the camera off, then retake.
    if (outcome.status === "deviation" && outcome.deviation) {
      opts.onProgress?.({
        sceneId: scene.id,
        attempt,
        phase: "verifying",
        detail: `recovering: ${outcome.deviation.detail}`,
      })
      const recovery = await recoverFromDeviation({
        workspace,
        modelId,
        script,
        deviation: outcome.deviation,
        guidance: opts.guidance,
        signal,
      })
      previousFailure =
        `deviated at step ${outcome.deviation.index} (${outcome.deviation.cmd}): ` +
        `${outcome.deviation.detail}. Recovery ${recovery.recovered ? "cleared it" : "failed"}: ${recovery.detail}`
      lastReport = infraFailureReport(previousFailure)
      log.warn(
        `[demo-workflow] scene ${scene.id} attempt ${attempt} ${previousFailure}`
      )
      opts.onProgress?.({
        sceneId: scene.id,
        attempt,
        phase: "failed",
        detail: previousFailure,
      })
      continue
    }

    // 5. Verify the artifact.
    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "verifying" })
    lastReport = await verifyScene({
      script,
      videoPath,
      voiceExpected: opts.voiceExpected,
    })

    if (lastReport.ok) {
      const duration = lastReport.checks.find(
        (c) => c.name === "duration-range"
      )
      opts.onProgress?.({ sceneId: scene.id, attempt, phase: "done" })
      return {
        status: "done",
        result: {
          sceneId: scene.id,
          videoPath,
          actionsPath,
          durationSec: Number(
            duration?.detail.match(/duration ([\d.]+)s/)?.[1] ?? 0
          ),
          endUrl: script.endUrl,
          attempts: attempt,
          verify: lastReport,
        },
      }
    }

    previousFailure =
      "failed verification — " +
      lastReport.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name}: ${c.detail}`)
        .join("; ")
    log.warn(
      `[demo-workflow] scene ${scene.id} attempt ${attempt} ${previousFailure}`
    )
    opts.onProgress?.({
      sceneId: scene.id,
      attempt,
      phase: "failed",
      detail: previousFailure,
    })
  }

  return { status: "failed", lastReport, attempts: attemptsMade }
}
