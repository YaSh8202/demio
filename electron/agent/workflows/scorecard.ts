// ── Run scorecard binding ────────────────────────────────────────────────────
//
// `<workspace>/scorecard.jsonl`, one line per event, append-only. JSONL and
// `appendFile` on purpose: no read-modify-write, so the rehearsal agent,
// three recovery sites and the scene loop can all write without a lock, and
// a crash mid-run keeps every line written before it. Never throws — a
// scorecard that cannot be written must not cost anyone a take.
//
// Read one with `bun run scorecard [threadId]`.

import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import log from "../../lib/logger"
import { projectSteps } from "./transcript"
import type { SceneScript } from "./script-schema"

const require = createRequire(import.meta.url)

const pure = require("./scorecard-pure.cjs") as {
  scoreRehearsal: (o: Record<string, unknown>) => Record<string, unknown>
  scoreRecovery: (o: Record<string, unknown>) => Record<string, unknown>
  scoreScene: (o: Record<string, unknown>) => Record<string, unknown>
}

export const SCORECARD_FILE = "scorecard.jsonl"

async function append(
  workspace: string,
  entry: Record<string, unknown>
): Promise<void> {
  try {
    await fs.mkdir(workspace, { recursive: true })
    await fs.appendFile(
      path.join(workspace, SCORECARD_FILE),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      "utf8"
    )
  } catch (err) {
    log.warn(
      `[scorecard] could not write: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export function recordRehearsal(o: {
  workspace: string
  flowId: string
  status: string
  detail: string
  text: string
  steps: unknown[]
  maxSteps: number
  scripts: SceneScript[]
  dress: { ran: boolean; ok?: boolean; detail?: string }
}): Promise<void> {
  return append(
    o.workspace,
    pure.scoreRehearsal({ ...o, steps: projectSteps(o.steps).steps })
  )
}

export function recordRecovery(o: {
  workspace: string
  sceneId: string
  script: SceneScript
  deviation: { index: number; cmd: string; detail: string }
  outcome: { recovered: boolean; detail: string; amended: boolean }
  steps: unknown[]
  maxSteps: number
}): Promise<void> {
  return append(
    o.workspace,
    pure.scoreRecovery({ ...o, steps: projectSteps(o.steps).steps })
  )
}

export function recordScene(o: {
  workspace: string
  sceneId: string
  status: "done" | "failed"
  attempts: number
  checks: Array<{ name: string; ok: boolean }>
  durationSec?: number
  expectedSec?: number
}): Promise<void> {
  return append(o.workspace, pure.scoreScene(o))
}

export function recordRun(o: {
  workspace: string
  scenes: number
  videoPath: string
}): Promise<void> {
  return append(o.workspace, {
    kind: "run",
    scenes: o.scenes,
    videoPath: o.videoPath,
  })
}
