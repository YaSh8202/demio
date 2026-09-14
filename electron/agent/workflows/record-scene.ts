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
// - `record restart <path> [flags]` accepts `--log-actions <path>`
//   (confirmed via `agent-browser record --help`). `recordingBracket` in
//   `replay-pure.cjs` builds the exact `open` / `wait` / `record restart`
//   commands issued below, and its header documents why `record start` is
//   never used: it re-navigates inside a fresh context, putting the app's
//   cold boot on camera.

import path from "node:path"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import { replayScene, checkReplayDuration } from "./replay"
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
  }) => {
    commands: string[]
    resetsPage: boolean
    preRollIndex: number | null
  }
  resolveParams: (script: SceneScript) => SceneScript
}

/**
 * Attempts per scene before the workflow suspends and asks the user.
 *
 * **Known consequence for a state-dependent `chained` scene: it is
 * effectively single-attempt.** `recordingBracket`'s retry path deliberately
 * re-opens `startUrl` before recording (attempt N-1's half-executed wreckage
 * is not a valid start state), and that fresh navigation discards exactly the
 * in-page state a chained scene continues from. So attempts 2 and 3 of such
 * a scene are deterministically doomed — they burn two takes and up to two
 * recovery LLM runs, and "retry with guidance" on the suspension card can
 * never succeed for them either.
 *
 * On the shipped fixture this is concrete: retrying `scene-02` re-opens
 * Main_Page with an empty search box, so `press Enter` does nothing.
 *
 * Not auto-failed on purpose: not every chained scene is state-dependent
 * (one that merely avoids a redundant reload retries fine), and
 * short-circuiting the budget would deny a working retry to those.
 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * A scene id becomes a path segment (`scenes/<id>.webm`, `.actions.jsonl`,
 * `.attempt-N.agent.json`), and scene plans are model-generated — so an id
 * containing `../` or `/` would write outside the workspace.
 *
 * `toScenesStep` in demo-video.ts already rejects unsafe ids at the workflow's
 * entry choke point; this is the same regex re-checked at the point of use,
 * because `recordSceneWithRetry` is exported and nothing stops a future
 * caller from bypassing that step. Keep the two in step.
 */
const SAFE_SCENE_ID = /^[a-zA-Z0-9._-]+$/

/**
 * Persist a debug artifact for one recording attempt.
 *
 * Replay is a bare deterministic run — no agent, no memory, no threadId —
 * so nothing about a given attempt reaches `mastra_messages` and it is
 * otherwise invisible after the run. We write the replay outcome (and the
 * failure context that led into it) next to the scene's other artifacts
 * (`<sceneId>.webm`, `<sceneId>.actions.jsonl`), plus — when the attempt
 * deviated — the recovery agent's own steps, which are the only on-disk
 * proof that recovery stayed inside its boundary.
 *
 * Called at most twice per attempt against the same path: once right after
 * `record stop`, and again with `recovery` merged in. The second write is a
 * superset of the first, never a replacement for it.
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
  /**
   * True when this invocation is the workflow resuming a scene the user chose
   * to retry. `sceneStep` re-runs from the top on resume, so the loop below
   * restarts at `attempt = 1` and would otherwise treat a resumed retry as a
   * first attempt — issuing `record restart` for a chained scene against
   * whatever the *previous failed attempt* left on screen, rather than the
   * previous scene's clean end state. That failure is silent: replay runs
   * cleanly from the wrong page and the resulting video still passes
   * video-exists / black-frames / duration-range.
   */
  resumedRetry?: boolean
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
  if (!SAFE_SCENE_ID.test(scene.id)) {
    // Throw rather than return `failed`: a `failed` return feeds the
    // suspend/retry loop, and retrying a traversal-shaped id can never
    // succeed. Name the offending id; never silently rewrite it.
    throw new Error(
      `record-scene: scene id "${scene.id}" is not a safe filename slug ` +
        `(must match ${SAFE_SCENE_ID})`
    )
  }
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  let lastReport: VerifyReport = { ok: false, checks: [] }
  let previousFailure = ""
  // Attempts *started*, not `maxAttempts` — an abort before attempt 1 (or
  // between attempts) must not be reported as if all `maxAttempts` ran.
  let attemptsMade = 0
  // The script in force for the NEXT attempt. Starts as the rehearsed one and
  // is replaced when off-camera recovery amends it — an amendment only ever
  // arrives already proven by a cold replay (see `recoverFromDeviation`), so
  // there is nothing to re-validate here.
  let activeScript = scene.script

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

    const rawScript = activeScript
    if (!rawScript) {
      // A scene without a script cannot be recorded. Rehearsal produces it;
      // `toScenesStep` merges it in. Fail loudly rather than silently
      // falling back to the deleted recorder agent.
      return {
        status: "failed",
        lastReport: infraFailureReport(
          `scene ${scene.id} has no script — the record pass requires one`
        ),
        attempts: attemptsMade,
      }
    }

    // Resolved BEFORE the recording bracket opens, so a script that names a
    // param it never defines fails with the camera off. Treated as a failed
    // take (matching the no-script case above) rather than thrown: it
    // surfaces on the suspension card where the user can read it, and the
    // wasted work is one loop iteration, not a killed run.
    let script: SceneScript
    try {
      script = pure.resolveParams(rawScript)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return {
        status: "failed",
        lastReport: infraFailureReport(detail),
        attempts: attemptsMade,
      }
    }

    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "recording" })

    // 1. Open the take. A chained scene picks up on the live page; an
    //    independent scene (or any retry) re-opens the start URL first.
    //    Either way the camera is only started once the scene's opening
    //    precondition holds.
    const bracket = pure.recordingBracket({
      script,
      videoPath,
      actionsPath,
      // `opts.resumedRetry` ORed in: on a resumed retry the loop starts over
      // at attempt 1, but the page is still whatever the last failed attempt
      // left behind — not a valid chained start state.
      isRetry: attempt > 1 || opts.resumedRetry === true,
    })
    // NOTE: execAgentBrowser takes ONE FULL COMMAND STRING per array
    // element — a single-element array is tokenized as one command, but a
    // multi-element array switches to `batch` mode, where `wrapBatchArgs`
    // escapes `\` and `"` but NOT `'`. `recordingBracket` single-quotes its
    // paths and URLs, and exec.ts spawns with no shell to strip them en
    // route — so each bracket command MUST be issued as its own
    // single-element call, never batched into one.
    //
    // The bracket may include a camera-off pre-roll `wait` (the first
    // action's precondition). Its failure lands here as "failed before
    // recording", which is accurate: the page never reached the state the
    // scene starts from, and nothing was captured.
    let bracketFailed = false
    let failedIndex = -1
    let failedError = ""
    for (const [i, cmd] of bracket.commands.entries()) {
      const r = await execAgentBrowser([cmd], { timeout: 60_000 })
      if (!r.ok) {
        // A stale recording session is the known failure mode — clear it.
        await execAgentBrowser(["record stop"], { timeout: 15_000 })
        failedIndex = i
        failedError = r.error ?? "unknown error"
        previousFailure = `failed before recording — \`${cmd}\` failed: ${failedError}`
        lastReport = infraFailureReport(previousFailure)
        bracketFailed = true
        break
      }
    }
    if (bracketFailed) {
      // A failed PRECONDITION is not an infrastructure failure — it means the
      // page was not in the state this scene starts from. That is the one
      // pre-recording failure recovery can act on, and the one where acting
      // sticks: signing in or clearing an interstitial is session state, which
      // survives the next attempt's re-`open`, unlike page state.
      //
      // Without this branch the loop is unwinnable by construction. Every
      // attempt reruns the identical bracket against the identical page and
      // fails identically, the user's "Retry scene" does the same, and because
      // the transcript is only written after replay, three attempts leave no
      // artifact at all. That is exactly what a script rehearsed in an
      // authenticated browser does when the record pass starts logged out.
      if (failedIndex === bracket.preRollIndex) {
        const deviation = {
          index: 0,
          cmd: script.actions[0].cmd,
          detail: `precondition \`${bracket.commands[failedIndex]}\` failed: ${failedError}`,
        }
        opts.onProgress?.({
          sceneId: scene.id,
          attempt,
          phase: "verifying",
          detail: `recovering: ${deviation.detail}`,
        })
        const recovery = await recoverFromDeviation({
          workspace,
          modelId,
          script,
          deviation,
          guidance: opts.guidance,
          signal,
        })
        // The plain-bracket path below writes no transcript because nothing
        // ran; here an agent did, and its steps are the only record of it.
        await writeAgentTranscript(transcriptPath, {
          sceneId: scene.id,
          attempt,
          modelId,
          previousFailure: previousFailure || null,
          replay: { status: "not-started", steps: [] },
          preRoll: {
            command: bracket.commands[failedIndex],
            error: failedError,
          },
          recovery: {
            recovered: recovery.recovered,
            detail: recovery.detail,
            steps: recovery.steps,
          },
        })
        if (recovery.amendedScript) activeScript = recovery.amendedScript
        previousFailure =
          `${deviation.detail} Recovery ` +
          `${recovery.recovered ? "cleared it" : "failed"}: ${recovery.detail}`
        lastReport = infraFailureReport(previousFailure)
      }
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
    //
    // 3. Recording ALWAYS stops before anything else happens — including
    //    when replay throws. `replayScene` propagates an unresolvable
    //    agent-browser binary (see its header), and `onStep` reaches
    //    `writer.write` in the workflow, which can throw synchronously.
    //    Either would escape past `record stop` and leave the camera rolling
    //    for the rest of the run, so the stop lives in a `finally`.
    let outcome: Awaited<ReturnType<typeof replayScene>>
    try {
      outcome = await replayScene({
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
    } finally {
      // Guarded so a throw from the stop itself cannot mask the original
      // error on the way out of the `finally`.
      try {
        const stop = await execAgentBrowser(["record stop"], {
          timeout: 30_000,
        })
        if (!stop.ok) {
          log.warn(
            `[demo-workflow] scene ${scene.id} attempt ${attempt} record stop failed: ${stop.error}`
          )
        }
      } catch (err) {
        log.warn(
          `[demo-workflow] scene ${scene.id} attempt ${attempt} record stop threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }

    const transcript: Record<string, unknown> = {
      sceneId: scene.id,
      attempt,
      modelId,
      previousFailure: previousFailure || null,
      replay: outcome,
    }
    // Written now, before recovery: if recovery hangs or the run is killed
    // mid-recovery, the replay evidence still survives on disk. Re-written
    // as a superset below once recovery has a verdict.
    await writeAgentTranscript(transcriptPath, transcript)

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
      // The recovery boundary — "may clear obstacles, must never perform the
      // scene's own scripted actions" — is the load-bearing rule of this
      // design, and this file is the only place it becomes checkable after
      // the fact. Persist the agent's steps into the SAME attempt transcript
      // (a superset of what was written above), so a reviewer can read one
      // file and confirm none of the script's commands appear in the
      // recovery agent's tool calls. See checklist item 29.
      await writeAgentTranscript(transcriptPath, {
        ...transcript,
        recovery: {
          recovered: recovery.recovered,
          detail: recovery.detail,
          steps: recovery.steps,
        },
      })
      // The retake replays THIS, not the script the attempt started with.
      if (recovery.amendedScript) activeScript = recovery.amendedScript
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

    // 6. Every step reported success and the FILE is still wrong. Replaying
    //    the same script again is provably identical — that is what six
    //    takes of electron-chromium-talk.01 proved, at 26.7 s each. The only
    //    thing that can change the next take is the script, so this goes to
    //    recovery with `canAmend`, framed as a deviation at the step that
    //    cost the most. Recovery is also the only place the user's "Retry
    //    with guidance" text is read, so without this branch that button
    //    could not do anything on a verification failure.
    //
    //    Gated on the REPLAY's own timing being out of band. If the replay
    //    predicted a fine take and the file still failed (missing, black,
    //    0.5 s against a 3.3 s prediction — search-wikipedia.01), the script
    //    was not the problem and amending it cannot help; that is the
    //    recording, and a plain retake is the right response.
    const dur = checkReplayDuration(script, outcome.steps)
    if (dur.ok) continue
    const tooSlow = dur.predictedMs > dur.expectedMs
    const deviation = {
      index: dur.slowest?.index ?? 0,
      cmd: dur.slowest?.cmd ?? script.actions[0].cmd,
      detail:
        `${previousFailure}. Step timings: ` +
        outcome.steps
          .map((s) => `${s.index}=${(s.durationMs / 1000).toFixed(1)}s`)
          .join(", ") +
        (tooSlow && dur.slowest
          ? `. Step ${dur.slowest.index} (\`${dur.slowest.cmd}\`) reported ` +
            `success but cost ${(dur.slowest.durationMs / 1000).toFixed(1)}s`
          : `. The replay ran faster than the script predicts (${(dur.predictedMs / 1000).toFixed(1)}s vs ${(dur.expectedMs / 1000).toFixed(1)}s)`),
    }
    opts.onProgress?.({
      sceneId: scene.id,
      attempt,
      phase: "verifying",
      detail: `recovering: ${deviation.detail}`,
    })
    const recovery = await recoverFromDeviation({
      workspace,
      modelId,
      script,
      deviation,
      guidance: opts.guidance,
      signal,
    })
    await writeAgentTranscript(transcriptPath, {
      ...transcript,
      verify: lastReport,
      recovery: {
        recovered: recovery.recovered,
        detail: recovery.detail,
        steps: recovery.steps,
      },
    })
    if (recovery.amendedScript) activeScript = recovery.amendedScript
    previousFailure += ` Recovery ${recovery.recovered ? "cleared it" : "failed"}: ${recovery.detail}`
    log.warn(
      `[demo-workflow] scene ${scene.id} attempt ${attempt} ${previousFailure}`
    )
    // Retake only if something changed: an amended script, or a page fix
    // recovery believes alters the take. Otherwise stop — the remaining
    // attempts would film the same thing and the user should decide.
    if (!recovery.amendedScript && !recovery.recovered) break
  }

  return { status: "failed", lastReport, attempts: attemptsMade }
}
