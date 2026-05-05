// ── Agent Run Buffer Registry ────────────────────────────────────────────────
//
// In-memory buffer of in-flight (and recently-finished) agent SSE streams,
// keyed by `${projectId}:${threadId}`. Lets a fresh renderer reattach to a
// running stream after refresh by replaying buffered chunks then subscribing
// to live `agent:onChunk` events for the same runId.
//
// Buffers survive briefly after a run ends (60s grace) so just-after-end
// refreshes still see the full message before the entry is GC'd.

const MAX_BYTES = 5 * 1024 * 1024
const GRACE_MS = 60_000

type RunState = "running" | "ended" | "errored"

export interface RunEntry {
  runId: string
  /** Each entry is one decoded SSE chunk. chunks[i] has seq i. */
  chunks: string[]
  /** Number of chunks accumulated so far. Equal to chunks.length unless truncated. */
  seq: number
  byteSize: number
  truncated: boolean
  state: RunState
  error?: string
  endedAt?: number
  gcTimer?: NodeJS.Timeout
}

export interface RunSnapshot {
  runId: string
  chunks: string[]
  seq: number
  state: RunState
  error: string | null
  truncated: boolean
}

const runs = new Map<string, RunEntry>()

export function runKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

/** Start a new run. Replaces any prior entry for the same key. */
export function startRun(key: string, runId: string): RunEntry {
  const prior = runs.get(key)
  if (prior?.gcTimer) clearTimeout(prior.gcTimer)
  const entry: RunEntry = {
    runId,
    chunks: [],
    seq: 0,
    byteSize: 0,
    truncated: false,
    state: "running",
  }
  runs.set(key, entry)
  return entry
}

/**
 * Append a chunk to the active run's buffer. Returns the chunk's seq
 * (== index in chunks array). Returns -1 if the run does not match
 * the registry's current entry (stale/completed run).
 */
export function appendChunk(key: string, runId: string, chunk: string): number {
  const entry = runs.get(key)
  if (!entry || entry.runId !== runId || entry.state !== "running") return -1
  if (entry.byteSize + chunk.length > MAX_BYTES) {
    entry.truncated = true
    return -1
  }
  const seq = entry.chunks.length
  entry.chunks.push(chunk)
  entry.seq = entry.chunks.length
  entry.byteSize += chunk.length
  return seq
}

function scheduleGc(key: string, entry: RunEntry) {
  entry.endedAt = Date.now()
  entry.gcTimer = setTimeout(() => {
    const current = runs.get(key)
    if (current === entry) runs.delete(key)
  }, GRACE_MS)
  entry.gcTimer.unref?.()
}

export function endRun(key: string, runId: string): void {
  const entry = runs.get(key)
  if (!entry || entry.runId !== runId) return
  entry.state = "ended"
  scheduleGc(key, entry)
}

export function errorRun(key: string, runId: string, message: string): void {
  const entry = runs.get(key)
  if (!entry || entry.runId !== runId) return
  entry.state = "errored"
  entry.error = message
  scheduleGc(key, entry)
}

/** Return the entry as a renderer-safe snapshot, or null if no entry. */
export function getActiveRunSnapshot(key: string): RunSnapshot | null {
  const entry = runs.get(key)
  if (!entry) return null
  return {
    runId: entry.runId,
    chunks: entry.chunks.slice(),
    seq: entry.seq,
    state: entry.state,
    error: entry.error ?? null,
    truncated: entry.truncated,
  }
}

/** Explicit eviction (e.g., when starting a fresh run replaces the prior one). */
export function clearRun(key: string): void {
  const entry = runs.get(key)
  if (!entry) return
  if (entry.gcTimer) clearTimeout(entry.gcTimer)
  runs.delete(key)
}
