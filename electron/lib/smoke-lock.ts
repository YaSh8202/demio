// ── Smoke-run lock ───────────────────────────────────────────────────────────
//
// agent-browser runs ONE daemon per machine, and the app's startup cleanup
// (`ensureDaemon` → `close --all`) closes every session on it — including a
// headless smoke run's, mid-take. The smoke runner holds this lock for the
// life of a run; the app checks it before cleaning up, and a second smoke run
// checks it before starting.
//
// Lives outside `~/.demio` (and outside `DEMIO_HOME`, which the app does not
// know) so both processes agree on the path and a smoke run leaves the live
// app's directory untouched.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function smokeLockPath(): string {
  return path.join(os.homedir(), ".demio-smoke.lock")
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The run holding the lock, or null — a lock whose pid is gone is stale. */
export function liveSmokeLock(): { pid: number; runId: string } | null {
  try {
    const lock = JSON.parse(fs.readFileSync(smokeLockPath(), "utf8")) as {
      pid?: number
      runId?: string
    }
    if (typeof lock.pid !== "number" || !pidAlive(lock.pid)) return null
    return { pid: lock.pid, runId: lock.runId ?? "" }
  } catch {
    return null
  }
}

/** Take the lock. Returns false if another live run holds it. */
export function acquireSmokeLock(runId: string): boolean {
  const held = liveSmokeLock()
  if (held && held.pid !== process.pid) return false
  fs.writeFileSync(
    smokeLockPath(),
    JSON.stringify({ pid: process.pid, runId, at: new Date().toISOString() })
  )
  return true
}

export function releaseSmokeLock(): void {
  const held = liveSmokeLock()
  if (held && held.pid !== process.pid) return
  try {
    fs.unlinkSync(smokeLockPath())
  } catch {
    // already gone
  }
}
