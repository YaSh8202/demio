// ── Agent Workspace ──────────────────────────────────────────────────────────
//
// Each thread gets an isolated workspace at:
//   ~/.demio/workspaces/<threadId>/
//       ├── brief.md
//       ├── script.md
//       ├── discovery/
//       ├── scenes/
//       └── output/

import fs from "node:fs"
import path from "node:path"
import { workspaceDir, ensureDir } from "../store/paths"

/** Resolve the workspace path for a thread. */
export function getWorkspace(threadId: string): string {
  return workspaceDir(threadId)
}

/** Create the workspace + subdirectories if missing. Idempotent. */
export function ensureWorkspace(threadId: string): string {
  const root = getWorkspace(threadId)
  ensureDir(root)
  for (const sub of ["discovery", "scenes", "output"]) {
    ensureDir(path.join(root, sub))
  }
  return root
}

/** True if the workspace directory exists. */
export function workspaceExists(threadId: string): boolean {
  return fs.existsSync(getWorkspace(threadId))
}
