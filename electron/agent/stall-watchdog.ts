// ── Stall watchdog (ADR-013) ─────────────────────────────────────────────────
//
// Everything in the demo-video workflow guarantees a video once
// `generate_demo` is running. Whether it ever runs was entirely the model's
// call: a turn can end "normally" — a plain-text question nobody is asked, a
// blocked rehearsal, a plan that never gets submitted — with no video, no
// error, and nothing left running. A weak model does this routinely.
//
// So when a turn ends with work started, no video, and no gate open, the
// harness moves, in code rather than in the prompt:
//
//   1. nudge   — tell the agent what is missing and what to call next (×2)
//   2. salvage — rehearsal proved scenes but the model never got them into an
//                approved plan: build the plan from `rehearsal/scripts.json`
//                and run the workflow directly. No model decision involved.
//   3. floor   — nothing was rehearsed at all: run the workflow with the floor
//                scene alone.
//
// It never answers for the user: an open `ask_user` or `submit_plan` is the
// user's turn, and the watchdog stands down. It also stands down when the
// turn did no work (a conversation, not a demo request) and when the user
// cancelled.

import fs from "node:fs"
import path from "node:path"
import log from "../lib/logger"
import { getProject } from "../store"
import { degradationNote, getOrCreateSession, runDemoVideo } from "./controller"
import { DEFAULT_MODEL_ID } from "./types"
import { ensureWorkspace } from "./workspace"
import { readCheckpoint, readScripts } from "./workflows/rehearsal"
import { floorScene } from "./workflows/demo-video"
import type { Scene } from "./workflows/schemas"
import { noteUserMessage, stallState } from "./stall-state"

export const MAX_NUDGES = 2
/** `agent_end` is not the end of the turn's events — let the dust settle. */
const SETTLE_MS = Number(process.env.DEMIO_STALL_SETTLE_MS) || 4_000

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const busy = new Set<string>()

type Emit = (key: string, event: Record<string, unknown>) => void

/** Feed every session event through here (session-driver does). */
export function watchForStall(
  key: string,
  projectId: string,
  threadId: string,
  event: Record<string, unknown>,
  emit: Emit
): void {
  const type = event["type"]
  if (type === "tool_start") {
    stallState(key).toolCalls += 1
  } else if (type === "agent_start") {
    const t = timers.get(key)
    if (t) clearTimeout(t)
  } else if (type === "agent_end") {
    const t = timers.get(key)
    if (t) clearTimeout(t)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        void check(key, projectId, threadId, emit).catch((err: unknown) =>
          log.error("[stall-watchdog] check failed:", err)
        )
      }, SETTLE_MS)
    )
  }
}

function freshVideo(workspace: string, since: number): string | null {
  const video = path.join(workspace, "output", "demo.mp4")
  try {
    const stat = fs.statSync(video)
    return stat.size > 0 && stat.mtimeMs >= since ? video : null
  } catch {
    return null
  }
}

async function check(
  key: string,
  projectId: string,
  threadId: string,
  emit: Emit
): Promise<void> {
  if (busy.has(key)) return
  const state = stallState(key)
  if (state.cancelled) return

  const session = await getOrCreateSession(projectId, threadId)
  const display = session.displayState.get()
  if (display.isRunning || display.pendingSuspensions.size > 0) return

  const workspace = ensureWorkspace(threadId)
  if (freshVideo(workspace, state.lastUserMessageAt)) return

  const checkpoint = await readCheckpoint(workspace)
  const started = state.toolCalls > 0 || checkpoint.flows.length > 0
  if (!started) return

  const scripts = (await readScripts(workspace)).scripts
  const doneFlows = new Set(
    checkpoint.flows
      .filter((f) => f.status === "done")
      .flatMap((f) => f.sceneIds)
  )
  const proven = scripts.filter((s) => doneFlows.has(s.sceneId))

  if (state.nudges < MAX_NUDGES) {
    state.nudges += 1
    const approved = Boolean(
      (session.state.get() as { activePlan?: unknown }).activePlan
    )
    const nudge = nudgeText({
      approved,
      proven: proven.map((s) => s.sceneId),
      blocked: checkpoint.flows
        .filter((f) => f.status !== "done")
        .map((f) => `${f.id} (${f.status}: ${f.detail})`),
    })
    log.warn(`[stall-watchdog] ${key}: nudge ${state.nudges}/${MAX_NUDGES}`)
    emit(key, { type: "harness_nudge", attempt: state.nudges, text: nudge })
    await session.sendMessage({ content: nudge })
    return
  }

  if (state.salvageTried) return
  state.salvageTried = true
  busy.add(key)
  try {
    const project = getProject(projectId)
    const targetUrl = toUrl(
      project?.project.domain ?? proven[0]?.startUrl ?? ""
    )
    const scenes: Scene[] =
      proven.length > 0
        ? proven.map((script) => ({
            id: script.sceneId,
            title: script.sceneId,
            goal:
              checkpoint.flows.find((f) => f.sceneIds.includes(script.sceneId))
                ?.label ?? script.sceneId,
            startUrl: script.startUrl,
            endUrl: script.endUrl,
            actions: script.actions.map((a) => a.cmd),
            script,
            expectedOutcome: "",
            narrationHint: "",
          }))
        : [floorScene(targetUrl)]
    log.warn(
      `[stall-watchdog] ${key}: still stalled after ${MAX_NUDGES} nudges — ` +
        (proven.length > 0
          ? `salvaging ${proven.length} rehearsed scene(s)`
          : "nothing was rehearsed, recording the floor scene")
    )
    emit(key, { type: "harness_salvage", scenes: scenes.map((s) => s.id) })
    const outcome = await runDemoVideo({
      projectId,
      threadId,
      plan: { demoTitle: project?.project.name ?? "Demo", targetUrl, scenes },
      modelId:
        session.model.get() || project?.meta?.selectedModel || DEFAULT_MODEL_ID,
      nudges: state.nudges,
      salvaged: true,
    })
    emit(key, { type: "harness_video_ready", ...outcome })
    // Into the conversation, so the user sees it where they are looking. The
    // video exists either way — this is the announcement, not the delivery.
    await session.sendMessage({
      content:
        "[harness] You stopped before producing the video, so the harness recorded it " +
        `from ${proven.length > 0 ? "the scenes you rehearsed" : "a fallback tour of the site"}: ` +
        'output/demo.mp4. Call present_files with ["output/demo.mp4"] now, then tell the ' +
        "user plainly that the harness had to finish the run" +
        (outcome.degraded.length > 0
          ? `. ${degradationNote(outcome.degraded)}`
          : "."),
    })
  } catch (err) {
    log.error(`[stall-watchdog] ${key}: salvage failed:`, err)
    emit(key, {
      type: "error",
      error: {
        name: "HarnessSalvageFailed",
        message: err instanceof Error ? err.message : String(err),
      },
    })
  } finally {
    busy.delete(key)
  }
}

function toUrl(domainOrUrl: string): string {
  if (!domainOrUrl) return "about:blank"
  return /^https?:\/\//.test(domainOrUrl)
    ? domainOrUrl
    : `https://${domainOrUrl}`
}

/** Specific on purpose: "continue" tells a stalled model nothing it did not already ignore. */
export function nudgeText(o: {
  approved: boolean
  proven: string[]
  blocked: string[]
}): string {
  const head =
    "[harness] Your turn ended, but there is no demo video yet and you did not ask the user " +
    "anything through ask_user. Nobody reads questions written as plain text — if you need a " +
    "decision, call ask_user; otherwise keep going until the video exists. "
  const blocked =
    o.blocked.length > 0
      ? ` Flows that did not finish rehearsal: ${o.blocked.join("; ")} — leave them out rather than stopping.`
      : ""
  if (o.approved) {
    return (
      head +
      "The plan is already approved. Next step: call generate_demo now with the json scene plan " +
      "from the plan file" +
      (o.proven.length > 0
        ? `. Scene ids must be exactly: ${o.proven.join(", ")}.`
        : ".") +
      blocked
    )
  }
  if (o.proven.length > 0) {
    return (
      head +
      `Rehearsal has proven these scenes: ${o.proven.join(", ")}. Next step: write the plan file ` +
      "with a fenced json scene plan using exactly those scene ids (and a `## Rehearsal report`), " +
      "then call submit_plan." +
      blocked
    )
  }
  return (
    head +
    "Nothing has been rehearsed yet. Next step: call rehearse_flow for the first flow of the demo." +
    blocked
  )
}

export { noteUserMessage }
