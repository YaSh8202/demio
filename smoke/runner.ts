// ── Smoke runner: one detached demio agent run ───────────────────────────────
//
//   bun smoke/runner.ts <runDir>        (spawned by `smoke start`, not by hand)
//
// Drives a real AgentController session — the same `session-driver` the IPC
// handlers use — with no Electron window, and keeps `state.json` current so
// `smoke watch` / `status` can read a run without talking to this process.
//
// The run lives in THIS process: the session and the demo-video workflow run
// are in memory, so an answer to a gate cannot be delivered by a second
// process resuming the run itself. `smoke answer` drops a file in `inbox/`;
// this process picks it up and resumes.
//
// State is derived from the event stream and the workspace on disk — never
// from `isRunning` (false while a tool sits in `suspend()`, so "not running"
// is not "finished") and never from mastra.db (`savePerStep: false`: nothing
// in a turn is persisted until the turn ends).

import fs from "node:fs"
import path from "node:path"
import {
  runFiles,
  readJson,
  writeJsonAtomic,
  type Gate,
  type RunOptions,
  type RunPhase,
  type RunState,
  type Scenario,
} from "./lib"

const dir = process.argv[2]
if (!dir) {
  console.error("usage: bun smoke/runner.ts <runDir>")
  process.exit(64)
}
const files = runFiles(dir)
const options = readJson<RunOptions>(files.options)
if (!options) {
  console.error(`no run.json in ${dir}`)
  process.exit(64)
}

// Before ANY agent module loads — `mastraStore` opens `$DEMIO_HOME/mastra.db`
// at module load, and agent-browser reads its session name per command. Hence
// the dynamic imports in `main()`, the same pattern as recovery.eval.ts.
process.env.DEMIO_HOME = options.home
process.env.AGENT_BROWSER_SESSION = `smoke-${options.runId}`

/** How long after `agent_end` with nothing pending before the run is called over. */
// Must outlast the stall watchdog's own settle (stall-watchdog.ts, 4s unless
// DEMIO_STALL_SETTLE_MS says otherwise): if this fired first, the runner would
// call the run stalled and exit — killing the process the watchdog was about
// to rescue it in.
const SETTLE_MS = Math.max(
  8_000,
  3 * (Number(process.env.DEMIO_STALL_SETTLE_MS) || 0)
)
const INBOX_POLL_MS = 500
const NOISY_EVENTS = new Set([
  "display_state_changed",
  "message_update",
  "tool_input_delta",
  "tool_update",
  "shell_output",
  "usage_update",
])
const LOGIN_QUESTION = /password|credential|log[\s-]?in|sign[\s-]?in|username/i

const state: RunState = {
  runId: options.runId,
  scenarioId: options.scenario.id,
  phase: "starting",
  pid: process.pid,
  modelId: options.modelId,
  startedAt: options.startedAt,
  updatedAt: options.startedAt,
  elapsedSec: 0,
  seq: 0,
  gates: [],
  gateLog: [],
  activeTools: [],
  turns: 0,
  toolCalls: 0,
  nudges: 0,
  errors: [],
}

function save(patch: Partial<RunState> = {}) {
  Object.assign(state, patch)
  state.seq += 1
  state.updatedAt = new Date().toISOString()
  state.elapsedSec = Math.round(
    (Date.now() - Date.parse(state.startedAt)) / 1000
  )
  writeJsonAtomic(files.state, state)
}

function logEvent(event: Record<string, unknown>) {
  fs.appendFileSync(
    files.events,
    JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"
  )
}

function videoPath(): string | null {
  if (!state.workspace) return null
  const video = path.join(state.workspace, "output", "demo.mp4")
  try {
    return fs.statSync(video).size > 0 ? video : null
  } catch {
    return null
  }
}

/** The workflow's own "I finished" record — a video file alone may still be mid-write. */
function scorecardHasRun(): boolean {
  if (!state.workspace) return false
  try {
    return fs
      .readFileSync(path.join(state.workspace, "scorecard.jsonl"), "utf8")
      .split("\n")
      .some((line) => line.includes('"kind":"run"'))
  } catch {
    return false
  }
}

function toGate(entry: Record<string, unknown>): Gate {
  const payload = (entry["suspendPayload"] ?? {}) as Record<string, unknown>
  const tool = String(entry["toolName"] ?? "")
  const gate: Gate = { tool, toolCallId: String(entry["toolCallId"] ?? "") }
  if (tool === "ask_user") {
    gate.question = String(payload["question"] ?? "")
    gate.options = payload["options"] as Gate["options"]
    gate.selectionMode = payload["selectionMode"] as string | undefined
  } else if (tool === "submit_plan") {
    gate.planPath = String(payload["path"] ?? "")
    gate.planContent = entry["planContent"] as string | undefined
  } else {
    gate.payload = payload
  }
  return gate
}

/** What the scenario already knows the answer to, or undefined to wait for `smoke answer`. */
function scenarioAnswer(
  scenario: Scenario,
  gate: Gate,
  unattended: boolean
):
  | { by: "scenario" | "auto-approve" | "unattended"; resumeData: unknown }
  | undefined {
  if (gate.tool === "submit_plan") {
    return scenario.approvePlan === "auto" || unattended
      ? { by: "auto-approve", resumeData: { action: "approved" } }
      : undefined
  }
  if (gate.tool !== "ask_user") return undefined
  const question = gate.question ?? ""
  for (const a of scenario.answers ?? []) {
    if (new RegExp(a.match, "i").test(question)) {
      return { by: "scenario", resumeData: a.answer }
    }
  }
  const creds = scenario.credentials
  if (creds && LOGIN_QUESTION.test(question)) {
    const url = creds.loginUrl ? `, login URL: ${creds.loginUrl}` : ""
    return {
      by: "scenario",
      resumeData: `username: ${creds.username}, password: ${creds.password}${url}`,
    }
  }
  if (unattended) {
    const first = gate.options?.[0]?.label
    return {
      by: "unattended",
      resumeData:
        first ??
        "No one is available to answer. Use your best judgement and continue.",
    }
  }
  return undefined
}

async function main(run: RunOptions) {
  fs.mkdirSync(files.inbox, { recursive: true })
  save()

  const { acquireSmokeLock, releaseSmokeLock, liveSmokeLock } =
    await import("../electron/lib/smoke-lock")
  if (!acquireSmokeLock(run.runId)) {
    const held = liveSmokeLock()
    save({
      phase: "error",
      detail: `another smoke run is live (${held?.runId}, pid ${held?.pid}) — runs are serial: one browser daemon`,
    })
    process.exit(1)
  }

  let finished = false
  const finish = (phase: RunPhase, detail?: string, code = 0) => {
    if (finished) return
    finished = true
    const video = videoPath() ?? undefined
    save({ phase, detail, video, gates: [], activeTools: [] })
    releaseSmokeLock()
    // Let the final state write and any in-flight log lines land.
    setTimeout(() => process.exit(code), 250)
  }

  process.on("uncaughtException", (error) => {
    state.errors.push({ at: new Date().toISOString(), message: String(error) })
    finish("error", `runner crashed: ${String(error)}`, 1)
  })
  process.on("unhandledRejection", (error) => {
    // Recorded, not fatal: the agent stack has floating promises of its own
    // (the app's main process survives them too).
    state.errors.push({ at: new Date().toISOString(), message: String(error) })
    save()
  })

  // NOTE: `initProviderKeys()` is deliberately never called. Outside Electron
  // there is no safeStorage, so it would base64-decode ciphertext into garbage
  // that `getModel` then prefers over a valid env key. Keys come from the
  // environment (`.env.local`, which bun loads) only.
  const { initStore, createProject, updateProjectMeta } =
    await import("../electron/store")
  const driver = await import("../electron/agent/session-driver")
  const { ensureWorkspace } = await import("../electron/agent/workspace")

  initStore()
  const scenario = run.scenario
  const { project, thread } = createProject(
    `smoke: ${scenario.id}`,
    run.modelId,
    { domain: scenario.domain }
  )
  if (scenario.voiceId) {
    updateProjectMeta(project.id, { voiceId: scenario.voiceId })
  }
  const projectId = project.id
  const threadId = thread.id
  save({ projectId, threadId, workspace: ensureWorkspace(threadId) })

  process.on("SIGTERM", () => {
    void driver.cancel(projectId, threadId).finally(() => {
      finish("error", "killed (SIGTERM)", 1)
    })
  })

  const handled = new Set<string>()
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let pending: Record<string, Record<string, unknown>> = {}
  let running = false
  // The stall watchdog is recording a salvaged video: no agent events arrive
  // while it does, and that silence is not the run being over.
  let harnessBusy = false

  const respond = (
    gate: Gate,
    resumeData: unknown,
    answeredBy: "scenario" | "auto-approve" | "unattended" | "cli"
  ) => {
    handled.add(gate.toolCallId)
    state.gateLog.push({
      at: new Date().toISOString(),
      tool: gate.tool,
      toolCallId: gate.toolCallId,
      question: gate.question,
      answeredBy,
      answer: resumeData,
    })
    save({
      phase: "running",
      gates: state.gates.filter((g) => g.toolCallId !== gate.toolCallId),
    })
    void driver
      .respondSuspension(projectId, threadId, {
        toolCallId: gate.toolCallId,
        resumeData,
      })
      .catch((error: unknown) => {
        state.errors.push({
          at: new Date().toISOString(),
          message: `respondSuspension failed: ${String(error)}`,
        })
        save()
      })
  }

  /** Decide whether the run is over. Called once things have been quiet for SETTLE_MS. */
  const settle = () => {
    settleTimer = null
    if (finished || running || harnessBusy) return
    if (Object.keys(pending).length > 0) return
    if (videoPath() && scorecardHasRun()) return finish("done")
    if (state.errors.length > 0) {
      return finish("error", state.errors[state.errors.length - 1].message, 1)
    }
    finish(
      "stalled",
      "the agent's turn ended with no video and no open gate",
      1
    )
  }
  const armSettle = () => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(settle, SETTLE_MS)
  }

  driver.addSessionEventSink((_key, event) => {
    if (finished) return
    const type = String(event["type"] ?? "")
    if (!NOISY_EVENTS.has(type)) logEvent(event)

    if (type === "agent_start") {
      running = true
      state.turns += 1
      if (settleTimer) clearTimeout(settleTimer)
      save({ phase: state.gates.length > 0 ? "waiting" : "running" })
    } else if (type === "agent_end") {
      running = false
      armSettle()
    } else if (type === "harness_nudge") {
      state.nudges = Number(event["attempt"]) || state.nudges + 1
      save()
    } else if (type === "harness_salvage") {
      harnessBusy = true
      if (settleTimer) clearTimeout(settleTimer)
      save({ detail: "the harness is salvaging the run" })
    } else if (type === "harness_video_ready") {
      harnessBusy = false
      save({ detail: undefined })
      armSettle()
    } else if (type === "tool_start") {
      state.toolCalls += 1
    } else if (type === "error") {
      harnessBusy = false
      const error = event["error"] as { message?: string } | undefined
      state.errors.push({
        at: new Date().toISOString(),
        message: error?.message ?? JSON.stringify(event["error"]),
      })
      save()
      armSettle()
    } else if (type === "display_state_changed") {
      const display = (event["displayState"] ?? {}) as Record<string, unknown>
      running = display["isRunning"] === true
      pending = (display["pendingSuspensions"] ?? {}) as typeof pending
      // The map keeps finished tools too — only the unfinished ones are "active".
      const activeTools = Object.values(
        (display["activeTools"] ?? {}) as Record<
          string,
          { name?: string; status?: string }
        >
      )
        .filter(
          (t) => t?.status === "running" || t?.status === "streaming_input"
        )
        .map((t) => t?.name ?? "?")

      const open = Object.values(pending)
        .map(toGate)
        .filter((g) => !handled.has(g.toolCallId))
      for (const gate of open) {
        const known = scenarioAnswer(scenario, gate, run.unattended)
        if (known) respond(gate, known.resumeData, known.by)
      }
      const gates = open.filter((g) => !handled.has(g.toolCallId))

      const gatesChanged =
        gates.map((g) => g.toolCallId).join() !==
        state.gates.map((g) => g.toolCallId).join()
      const toolsChanged = activeTools.join() !== state.activeTools.join()
      if (gatesChanged || toolsChanged) {
        save({
          gates,
          activeTools,
          phase: gates.length > 0 ? "waiting" : "running",
        })
      }
      if (gates.length > 0 && settleTimer) clearTimeout(settleTimer)
    }
  })

  // Answers from `smoke answer`.
  setInterval(() => {
    if (finished) return
    for (const name of fs.readdirSync(files.inbox)) {
      if (!name.endsWith(".json")) continue
      const file = path.join(files.inbox, name)
      const answer = readJson<{ toolCallId: string; resumeData: unknown }>(file)
      fs.renameSync(file, `${file}.taken`)
      const gate = state.gates.find((g) => g.toolCallId === answer?.toolCallId)
      if (!answer || !gate) {
        state.errors.push({
          at: new Date().toISOString(),
          message: `answer for unknown or already-answered gate: ${name}`,
        })
        save()
        continue
      }
      respond(gate, answer.resumeData, "cli")
    }
  }, INBOX_POLL_MS)

  // The hard stop. Nothing in the agent stack has a wall-clock limit of its
  // own (not `agent.generate`, not the workflow, not the compose ffmpeg), so
  // without this a stalled provider connection hangs `smoke watch` forever.
  setTimeout(() => {
    void driver.cancel(projectId, threadId).finally(() => {
      finish(
        "timeout",
        `exceeded the ${run.timeoutSec}s wall-clock budget` +
          (state.activeTools.length > 0
            ? ` while running ${state.activeTools.join(", ")}`
            : ""),
        1
      )
    })
  }, run.timeoutSec * 1000)

  // Keeps elapsedSec honest for `status` while a long tool call emits nothing.
  setInterval(() => !finished && save(), 15_000)

  await driver.sendMessage(projectId, threadId, {
    text: scenario.prompt,
    modelId: run.modelId,
  })
  save({ phase: "running" })
}

main(options).catch((error: unknown) => {
  console.error(error)
  state.errors.push({ at: new Date().toISOString(), message: String(error) })
  save({ phase: "error", detail: `runner failed to start: ${String(error)}` })
  process.exit(1)
})
