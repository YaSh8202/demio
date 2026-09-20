// ── Smoke run: shared shapes and paths ───────────────────────────────────────
//
// Imported by both the CLI and the detached runner. No agent code is imported
// here: the CLI must stay cheap to start, and the runner must set its
// environment before any agent module loads (`mastraStore` opens its database
// at module load — see store/paths.ts).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Default model: the cheap one. A harness that delivers on this delivers on anything. */
export const SMOKE_DEFAULT_MODEL_ID = "google:gemini-3.8-flash"
export const SMOKE_DEFAULT_TIMEOUT_SEC = 30 * 60

export interface Scenario {
  id: string
  domain: string
  prompt: string
  modelId?: string
  voiceId?: string
  /** Offered to the agent when it asks for a login. */
  credentials?: { username: string; password: string; loginUrl?: string }
  /** Pre-supplied `ask_user` answers: first pattern that matches the question wins. */
  answers?: Array<{ match: string; answer: string | string[] }>
  /** "auto" approves `submit_plan` unattended. Default: the gate waits for `smoke answer`. */
  approvePlan?: "auto" | "ask"
  expect?: { minScenes?: number; maxDegraded?: number; minDurationSec?: number }
}

export interface RunOptions {
  runId: string
  scenario: Scenario
  modelId: string
  timeoutSec: number
  /** Nobody is at the gates (a sweep): approve plans, give unanticipated questions a fixed reply. */
  unattended: boolean
  home: string
  startedAt: string
}

export type RunPhase =
  | "starting"
  | "running"
  | "waiting"
  | "done"
  | "stalled"
  | "error"
  | "timeout"

/** A state `watch` returns on: something a caller must look at or act on. */
export const ATTENTION_PHASES: ReadonlySet<RunPhase> = new Set([
  "waiting",
  "done",
  "stalled",
  "error",
  "timeout",
])

/** A state after which the runner has exited. */
export const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set([
  "done",
  "stalled",
  "error",
  "timeout",
])

export interface Gate {
  tool: string
  toolCallId: string
  question?: string
  options?: Array<{ label: string; description?: string }>
  selectionMode?: string
  planPath?: string
  planContent?: string
  payload?: unknown
}

export interface GateLogEntry {
  at: string
  tool: string
  toolCallId: string
  question?: string
  answeredBy: "scenario" | "auto-approve" | "unattended" | "cli"
  answer: unknown
}

export interface RunState {
  runId: string
  scenarioId: string
  phase: RunPhase
  pid: number
  modelId: string
  projectId?: string
  threadId?: string
  workspace?: string
  startedAt: string
  updatedAt: string
  elapsedSec: number
  /** Bumped on every write, so `watch` can tell a fresh "waiting" from the one it already returned. */
  seq: number
  /** Open gates, oldest first. Non-empty exactly when phase is "waiting". */
  gates: Gate[]
  gateLog: GateLogEntry[]
  activeTools: string[]
  turns: number
  toolCalls: number
  /** Times the stall watchdog had to push the agent on. */
  nudges: number
  errors: Array<{ at: string; message: string }>
  video?: string
  detail?: string
}

export function smokeHome(): string {
  return process.env.DEMIO_SMOKE_HOME || path.join(os.homedir(), ".demio-smoke")
}

export function runDir(runId: string, home = smokeHome()): string {
  return path.join(home, "smoke-runs", runId)
}

export const runFiles = (dir: string) => ({
  options: path.join(dir, "run.json"),
  state: path.join(dir, "state.json"),
  events: path.join(dir, "events.jsonl"),
  inbox: path.join(dir, "inbox"),
  log: path.join(dir, "runner.log"),
})

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

/** Write-then-rename, so a reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function readState(runId: string): RunState | null {
  return readJson<RunState>(runFiles(runDir(runId)).state)
}

/** Most recent run ids first. */
export function listRunIds(): string[] {
  const root = path.join(smokeHome(), "smoke-runs")
  try {
    return fs
      .readdirSync(root)
      .map((id) => ({ id, at: fs.statSync(path.join(root, id)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .map((r) => r.id)
  } catch {
    return []
  }
}

export function newRunId(): string {
  return `sm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

export { pidAlive } from "../electron/lib/smoke-lock"
