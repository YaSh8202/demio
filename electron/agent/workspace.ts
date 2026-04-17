// ── Agent Workspace ──────────────────────────────────────────────────────────
//
// The agent's working directory lives inside the thread directory so every
// demo-generation run has isolated artifacts:
//   ~/.demio/projects/<pid>/threads/<tid>/workspace/
//       ├── brief.md
//       ├── discovery/
//       ├── script.md
//       ├── scenes/
//       └── output/

import fs from "node:fs"
import path from "node:path"
import { threadWorkspaceDir, ensureDir } from "../store/paths"

/** Resolve the workspace path for a thread. */
export function getWorkspace(projectId: string, threadId: string): string {
  return threadWorkspaceDir(projectId, threadId)
}

/** Create the workspace + subdirectories if missing. Idempotent. */
export function ensureWorkspace(projectId: string, threadId: string): string {
  const root = getWorkspace(projectId, threadId)
  ensureDir(root)
  for (const sub of ["discovery", "scenes", "output"]) {
    ensureDir(path.join(root, sub))
  }
  return root
}

/** True if the workspace directory exists. */
export function workspaceExists(projectId: string, threadId: string): boolean {
  return fs.existsSync(getWorkspace(projectId, threadId))
}
