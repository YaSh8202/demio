// ── Rehearsal artifact store ────────────────────────────────────────────────
//
// The impure half of rehearsal's persistence: paths, reads, atomic writes.
// Every decision about document SHAPE lives in `rehearsal-pure.cjs` and is
// unit-tested there; this file only moves bytes.
//
// Four artifacts under `<workspace>/rehearsal/` (spec §10):
//   scripts.json   — executable steps, appended per scene as proven
//   findings.md    — ambiguous selectors, required waits, blockers, state created
//   checkpoint.json— which flows are done, and which one is mid-flight
//   screenshots/   — per-step, for human review and a future vision judge

import path from "node:path"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import type { SceneScript } from "./script-schema"
import { assertScriptLints } from "./replay"

const require = createRequire(import.meta.url)

export type FlowStatus = "in-progress" | "done" | "blocked"
export type FindingKind =
  | "selector"
  | "wait"
  | "blocker"
  | "state-created"
  | "note"

export interface FlowEntry {
  id: string
  label: string
  startUrl: string
  status: FlowStatus
  sceneIds: string[]
  detail: string
}
export interface ScriptsDoc {
  version: number
  scripts: SceneScript[]
}
export interface CheckpointDoc {
  version: number
  flows: FlowEntry[]
}

const pure = require("./rehearsal-pure.cjs") as {
  emptyScripts: () => ScriptsDoc
  mergeScript: (doc: ScriptsDoc, script: SceneScript) => ScriptsDoc
  dropFlowScripts: (doc: ScriptsDoc, flowId: string) => ScriptsDoc
  emptyCheckpoint: () => CheckpointDoc
  beginFlow: (
    doc: CheckpointDoc,
    f: { id: string; label: string; startUrl: string }
  ) => CheckpointDoc
  finishFlow: (
    doc: CheckpointDoc,
    f: {
      id: string
      status: FlowStatus
      sceneIds: string[]
      detail: string
    }
  ) => CheckpointDoc
  inProgressFlow: (doc: CheckpointDoc) => FlowEntry | null
  FINDING_KINDS: string[]
  appendFinding: (
    markdown: string,
    e: { flowId: string; kind: FindingKind; text: string }
  ) => string
}

export const REHEARSAL_DIR = "rehearsal"

export function rehearsalPaths(workspace: string) {
  const dir = path.join(workspace, REHEARSAL_DIR)
  return {
    dir,
    scripts: path.join(dir, "scripts.json"),
    findings: path.join(dir, "findings.md"),
    checkpoint: path.join(dir, "checkpoint.json"),
    screenshots: path.join(dir, "screenshots"),
  }
}

export async function ensureRehearsalDirs(workspace: string): Promise<void> {
  const p = rehearsalPaths(workspace)
  await fs.mkdir(p.screenshots, { recursive: true })
}

/**
 * Serialize every read-modify-write against one workspace.
 *
 * The sub-agent's tools are awaited one at a time inside a single agent loop,
 * so interleaving is not expected — but two `rehearse_flow` calls in flight at
 * once (a model that ignores the one-flow-at-a-time instruction) would
 * otherwise race, and the loser's write silently wins. A promise chain per
 * workspace costs nothing and removes the class.
 *
 * In-process only: this is the Electron main process and there is exactly one.
 */
const writeChains = new Map<string, Promise<unknown>>()

function serialize<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(workspace) ?? Promise.resolve()
  // `.catch` on the CHAIN, not the caller's promise: one failed write must not
  // poison every later write for this workspace.
  const next = prev.then(fn, fn)
  writeChains.set(
    workspace,
    next.catch(() => undefined)
  )
  return next
}

/** Write via a temp file + rename, so a crash mid-write cannot truncate an artifact. */
async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, contents, "utf8")
  await fs.rename(tmp, filePath)
}

async function readJson<T>(filePath: string, fallback: () => T): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback()
    throw err
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    // Name the file. A corrupt artifact is recoverable by hand; a bare
    // "Unexpected token" three layers down inside an agent tool is not.
    throw new Error(
      `rehearsal: ${filePath} is not valid JSON — ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

// ── scripts ─────────────────────────────────────────────────────────────────

export async function readScripts(workspace: string): Promise<ScriptsDoc> {
  return readJson(rehearsalPaths(workspace).scripts, pure.emptyScripts)
}

/**
 * Record one proven scene script.
 *
 * Idempotent by sceneId (`mergeScript` replaces in place), so the rehearsal
 * agent is expected to call this repeatedly for the SAME scene as its action
 * list grows — after every proven step, not once at the end of the scene.
 * That is spec §9's rule: precision lives in this file, not in a summary.
 */
export async function recordScript(
  workspace: string,
  script: SceneScript
): Promise<void> {
  // The write is the gate. Both writers — rehearsal's `record_scene_script`
  // and recovery's `amend_scene_script` — reach disk through here, so a
  // script that fails lint is rejected in the tool call that tried to write
  // it, with every finding listed, while the agent still has the page open.
  assertScriptLints(script)
  const file = rehearsalPaths(workspace).scripts
  return serialize(workspace, async () => {
    const doc = await readJson(file, pure.emptyScripts)
    await writeAtomic(
      file,
      JSON.stringify(pure.mergeScript(doc, script), null, 2)
    )
  })
}

/**
 * Forget everything a flow proved, so it can be rehearsed again from scratch.
 *
 * Called by `rehearseFlow` before every attempt. A second attempt may produce
 * fewer scenes than the first (a resumed run, or a revision after Gate B), and
 * merging alone would leave the extras behind as orphans that `toScenesStep`
 * would happily hand to the recorder.
 */
export async function dropFlowScripts(
  workspace: string,
  flowId: string
): Promise<void> {
  const file = rehearsalPaths(workspace).scripts
  return serialize(workspace, async () => {
    const doc = await readJson(file, pure.emptyScripts)
    await writeAtomic(
      file,
      JSON.stringify(pure.dropFlowScripts(doc, flowId), null, 2)
    )
  })
}

// ── checkpoint ──────────────────────────────────────────────────────────────

export async function readCheckpoint(
  workspace: string
): Promise<CheckpointDoc> {
  return readJson(rehearsalPaths(workspace).checkpoint, pure.emptyCheckpoint)
}

export async function inProgressFlow(
  workspace: string
): Promise<FlowEntry | null> {
  return pure.inProgressFlow(await readCheckpoint(workspace))
}

export async function beginFlow(
  workspace: string,
  flow: { id: string; label: string; startUrl: string }
): Promise<void> {
  const file = rehearsalPaths(workspace).checkpoint
  return serialize(workspace, async () => {
    const doc = await readJson(file, pure.emptyCheckpoint)
    await writeAtomic(file, JSON.stringify(pure.beginFlow(doc, flow), null, 2))
  })
}

export async function finishFlow(
  workspace: string,
  flow: {
    id: string
    status: FlowStatus
    sceneIds: string[]
    detail: string
  }
): Promise<void> {
  const file = rehearsalPaths(workspace).checkpoint
  return serialize(workspace, async () => {
    const doc = await readJson(file, pure.emptyCheckpoint)
    await writeAtomic(file, JSON.stringify(pure.finishFlow(doc, flow), null, 2))
  })
}

// ── findings ────────────────────────────────────────────────────────────────

export async function readFindings(workspace: string): Promise<string> {
  try {
    return await fs.readFile(rehearsalPaths(workspace).findings, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw err
  }
}

export async function recordFinding(
  workspace: string,
  entry: { flowId: string; kind: FindingKind; text: string }
): Promise<void> {
  const file = rehearsalPaths(workspace).findings
  return serialize(workspace, async () => {
    let existing = ""
    try {
      existing = await fs.readFile(file, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    await writeAtomic(file, pure.appendFinding(existing, entry))
  })
}
