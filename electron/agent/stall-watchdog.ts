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
// It never answers for the user. An open `ask_user` or `submit_plan` is the
// user's turn, and the watchdog stands down; so it does after a cancel. And
// it only ever acts on a demo request that stalled — one that, SINCE THE USER
// LAST SPOKE, called a pipeline tool or rehearsed something. What an earlier
// request left in the workspace says nothing about this one: "thanks, looks
// great" after a delivered video must not be nudged into re-recording over it,
// and neither must a question the agent read a file to answer.

import fs from "node:fs"
import path from "node:path"
import log from "../lib/logger"
import { getProject } from "../store"
import { degradationNote, getOrCreateSession, runDemoVideo } from "./controller"
import { DEFAULT_MODEL_ID } from "./types"
import { ensureWorkspace } from "./workspace"
import {
  readCheckpoint,
  readScripts,
  rehearsalPaths,
} from "./workflows/rehearsal"
import { floorScene } from "./workflows/demo-video"
import type { Scene } from "./workflows/schemas"
import { PIPELINE_TOOLS, stallState } from "./stall-state"

export const MAX_NUDGES = 2

/**
 * Tool calls a turn may make between pipeline calls before the watchdog ends
 * it. The controller's own per-turn limit is 1000 steps and is not
 * configurable, so a model that cannot get past an obstacle — a login button
 * that ignores clicks — pokes at it by hand indefinitely: one smoke run made
 * 91 shell commands this way after its rehearsal had already spent 100 on the
 * same button. That never ends the turn, so nothing else here ever runs.
 * Ending it hands the run to the ladder, which does know what to do next.
 */
const TURN_TOOL_BUDGET = Number(process.env.DEMIO_TURN_TOOL_BUDGET) || 60
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
    const state = stallState(key)
    if (PIPELINE_TOOLS.has(String(event["toolName"]))) {
      state.pipelineCalls += 1
      state.looseCalls = 0
    } else if (++state.looseCalls > TURN_TOOL_BUDGET && !state.overBudget) {
      state.overBudget = true
      log.warn(
        `[stall-watchdog] ${key}: ${state.looseCalls} tool calls with no pipeline progress — ending the turn`
      )
      emit(key, { type: "harness_turn_ended", toolCalls: state.looseCalls })
      // `session.abort()`, not the driver's `cancel`: this is not the user
      // stopping the run, and the ladder must still act on what follows.
      void getOrCreateSession(projectId, threadId)
        .then((session) => session.abort())
        .catch((err: unknown) =>
          log.error("[stall-watchdog] could not end the turn:", err)
        )
    }
  } else if (type === "agent_start") {
    // A new turn (the user's, or a nudge's) gets a fresh allowance.
    stallState(key).looseCalls = 0
    stallState(key).overBudget = false
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

/**
 * The watchdog speaks through `session.sendMessage` directly, which — unlike
 * the driver's — selects no model. In a process that has not yet sent a user
 * message on this thread (after a restart; `smoke salvage`) that falls through
 * to the controller's default provider, whose key the user may not even have.
 */
function useProjectModel(
  session: Awaited<ReturnType<typeof getOrCreateSession>>,
  projectId: string
): void {
  if (session.model.hasSelection()) return
  session.model.set({
    modelId: getProject(projectId)?.meta?.selectedModel || DEFAULT_MODEL_ID,
  })
}

function modifiedSince(file: string, since: number): boolean {
  try {
    return fs.statSync(file).mtimeMs >= since
  } catch {
    return false
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

/**
 * Out of time: stop asking the model and deliver what rehearsal has proven —
 * or the floor scene if it proved nothing. For a caller with a deadline (the
 * smoke runner's wall clock) and for a run that died with proven scenes on
 * disk (`smoke salvage`). A run that is slow but working should end with the
 * video it earned, not with nothing because a clock ran out.
 */
export async function wrapUp(
  key: string,
  projectId: string,
  threadId: string,
  emit: Emit
): Promise<void> {
  const t = timers.get(key)
  if (t) clearTimeout(t)
  const session = await getOrCreateSession(projectId, threadId)
  // Not the driver's `cancel`: that marks the run as stopped by the user.
  if (session.displayState.get().isRunning) session.abort()
  await check(key, projectId, threadId, emit, true)
}

async function check(
  key: string,
  projectId: string,
  threadId: string,
  emit: Emit,
  /** `wrapUp`: skip every "is this a stall?" test and the nudges — go straight to recording. */
  force = false
): Promise<void> {
  if (busy.has(key)) return
  const state = stallState(key)
  if (state.cancelled && !force) return

  const session = await getOrCreateSession(projectId, threadId)
  const display = session.displayState.get()
  if (!force && (display.isRunning || display.pendingSuspensions.size > 0)) {
    return
  }

  const workspace = ensureWorkspace(threadId)
  if (!force && freshVideo(workspace, state.lastUserMessageAt)) return

  // Is THIS request a demo being made? A pipeline tool ran since the user
  // spoke, or rehearsal wrote its checkpoint since then (the same fact, read
  // off disk). Both are per-process: after an app restart the watchdog knows
  // nothing about the request in flight and stays out of it — the cost of
  // never mistaking an old thread's leftovers for a stalled demo.
  // `activePlan` is deliberately not a signal: it persists for the life of the
  // thread, long after the request that set it.
  const started =
    // Sixty tool calls is not a conversation, whatever they were.
    state.overBudget ||
    state.pipelineCalls > 0 ||
    modifiedSince(rehearsalPaths(workspace).checkpoint, state.lastUserMessageAt)
  if (!started && !force) return
  const approved = Boolean(
    (session.state.get() as { activePlan?: unknown }).activePlan
  )

  const checkpoint = await readCheckpoint(workspace)

  const scripts = (await readScripts(workspace)).scripts
  const doneFlows = new Set(
    checkpoint.flows
      .filter((f) => f.status === "done")
      .flatMap((f) => f.sceneIds)
  )
  const proven = scripts.filter((s) => doneFlows.has(s.sceneId))

  if (state.nudges < MAX_NUDGES && !force) {
    state.nudges += 1
    const nudge = nudgeText({
      approved,
      proven: proven.map((s) => s.sceneId),
      blocked: checkpoint.flows
        .filter((f) => f.status !== "done")
        .map((f) => `${f.id} (${f.status}: ${f.detail})`),
    })
    log.warn(`[stall-watchdog] ${key}: nudge ${state.nudges}/${MAX_NUDGES}`)
    emit(key, { type: "harness_nudge", attempt: state.nudges, text: nudge })
    useProjectModel(session, projectId)
    await session.sendMessage({ content: nudge })
    return
  }

  if (state.salvageTried && !force) return
  state.salvageTried = true
  busy.add(key)
  const salvage = new AbortController()
  state.salvage = salvage
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
      signal: salvage.signal,
    })
    emit(key, { type: "harness_video_ready", ...outcome })
    // The user moved on while it recorded: the video is there, but this is
    // no longer the conversation to announce it in.
    if (salvage.signal.aborted) return
    // Into the conversation, so the user sees it where they are looking. The
    // video exists either way — this is the announcement, not the delivery.
    useProjectModel(session, projectId)
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
    if (salvage.signal.aborted) {
      emit(key, { type: "harness_salvage_cancelled" })
      return
    }
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
    if (state.salvage === salvage) state.salvage = undefined
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
