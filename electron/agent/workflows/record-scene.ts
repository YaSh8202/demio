// ── Record-scene step (ADR-003, ADR-005) ────────────────────────────────────
//
// Harness owns the recording lifecycle: open start URL, start recording,
// run the recorder agent for ONE scene, stop recording, mechanically verify.
// Retries with the failure report fed back, max 3 attempts.
//
// Reconciled against installed APIs (Task 11):
// - `agent-browser url` does not exist — `execAgentBrowser(["get", "url"])`
//   is the real subcommand (confirmed via the installed binary's
//   `agent-browser get --help`: "url  Get current URL").
// - `record start <path> [url] [flags]` accepts `--log-actions <path>`
//   (confirmed via `agent-browser record --help`).
// - `recorder.generate(message, { abortSignal, maxSteps })` matches the
//   installed `@mastra/core@1.55.0` `AgentExecutionOptionsBase` shape
//   (`agent/agent.types.d.ts:386,419` — both `abortSignal` and `maxSteps`
//   are plain fields, no `stopWhen`/`stepCountIs` needed here).

import path from "node:path"
import { WORKSPACE_TOOLS } from "@mastra/core/workspace"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import { createDemioAgent } from "../mastra"
import { verifyScene } from "./verify"
import type { Scene, SceneResult, VerifyReport } from "./schemas"
import { recorderInstructions } from "../prompts"
import log from "../../lib/logger"

const DEFAULT_MAX_ATTEMPTS = 3

/** Recorder tool allowlist — execute/read/edit only, no present_files/synthesize_voiceover. */
const RECORDER_TOOL_FILTER = [
  WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
]

async function currentUrl(): Promise<string> {
  const r = await execAgentBrowser(["get", "url"], { timeout: 10_000 })
  return r.ok ? String(r.output).trim() : ""
}

export async function recordSceneWithRetry(opts: {
  scene: Scene
  workspace: string
  modelId: string
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) break
    const videoPath = path.join(workspace, "scenes", `${scene.id}.webm`)
    const actionsPath = path.join(workspace, "scenes", `${scene.id}.actions.jsonl`)

    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "recording" })

    // 1. Position the browser BEFORE recording so page-load isn't in the video.
    const open = await execAgentBrowser(["open", scene.startUrl], { timeout: 60_000 })
    if (!open.ok) {
      previousFailure = `could not open ${scene.startUrl}: ${open.error}`
      continue
    }

    // 2. Harness starts recording (ADR-005 — agent never touches the lifecycle).
    const rec = await execAgentBrowser(
      ["record", "start", videoPath, "--log-actions", actionsPath],
      { timeout: 30_000 }
    )
    if (!rec.ok) {
      // A stale recording session is the known failure mode — clear and retry.
      await execAgentBrowser(["record", "stop"], { timeout: 15_000 })
      previousFailure = `record start failed: ${rec.error}`
      continue
    }

    // 3. Recorder agent performs the scene's actions via execute_command.
    try {
      const recorder = createDemioAgent({
        workspace,
        signal,
        modelId,
        toolFilter: RECORDER_TOOL_FILTER,
        instructionsOverride: recorderInstructions({
          workspace,
          scene,
          attempt,
          previousFailure,
        }),
      })
      await recorder.generate(`Record scene ${scene.id}: ${scene.title}`, {
        abortSignal: signal,
        maxSteps: 30,
      })
    } finally {
      // 4. Recording ALWAYS stops, agent success or not.
      await execAgentBrowser(["record", "stop"], { timeout: 30_000 })
    }

    // 5. Mechanical verify (ADR-004 Layer 1).
    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "verifying" })
    const finalUrl = await currentUrl()
    lastReport = await verifyScene({ scene, videoPath, actionsPath, finalUrl })

    if (lastReport.ok) {
      const duration = lastReport.checks.find((c) => c.name === "duration-range")
      opts.onProgress?.({ sceneId: scene.id, attempt, phase: "done" })
      return {
        status: "done",
        result: {
          sceneId: scene.id,
          videoPath,
          actionsPath,
          durationSec: Number(duration?.detail.match(/duration ([\d.]+)s/)?.[1] ?? 0),
          endUrl: finalUrl,
          attempts: attempt,
          verify: lastReport,
        },
      }
    }

    previousFailure = lastReport.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.name}: ${c.detail}`)
      .join("; ")
    log.warn(`[demo-workflow] scene ${scene.id} attempt ${attempt} failed: ${previousFailure}`)
    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "failed", detail: previousFailure })
  }

  return { status: "failed", lastReport, attempts: maxAttempts }
}
