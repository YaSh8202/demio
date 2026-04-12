// ── Path Helpers ─────────────────────────────────────────────────────────────
//
// All store paths are derived from ~/.demio/ (hardcoded).
// Directory creation is lazy — ensureDir() is called before writes.

import os from "node:os"
import path from "node:path"
import fs from "node:fs"

/** Root store directory: ~/.demio */
export function storeRoot(): string {
  return path.join(os.homedir(), ".demio")
}

/** Global project index: ~/.demio/projects.json */
export function projectIndexPath(): string {
  return path.join(storeRoot(), "projects.json")
}

/** Project directory: ~/.demio/projects/<id>/ */
export function projectDir(projectId: string): string {
  return path.join(storeRoot(), "projects", projectId)
}

/** Project metadata: ~/.demio/projects/<id>/meta.json */
export function projectMetaPath(projectId: string): string {
  return path.join(projectDir(projectId), "meta.json")
}

/** Thread index: ~/.demio/projects/<id>/threads/index.json */
export function threadIndexPath(projectId: string): string {
  return path.join(projectDir(projectId), "threads", "index.json")
}

/** Thread directory: ~/.demio/projects/<id>/threads/ */
export function threadsDir(projectId: string): string {
  return path.join(projectDir(projectId), "threads")
}

/** Thread messages file: ~/.demio/projects/<id>/threads/<threadId>.jsonl */
export function threadMessagesPath(
  projectId: string,
  threadId: string
): string {
  return path.join(threadsDir(projectId), `${threadId}.jsonl`)
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Ensure a directory exists (recursive). No-op if it already does. */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

/**
 * Atomic write: write to .tmp then rename.
 * Prevents corruption if the process crashes mid-write.
 */
export function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + ".tmp"
  fs.writeFileSync(tmp, data, "utf-8")
  fs.renameSync(tmp, filePath)
}

/**
 * Atomic write (async): write to .tmp then rename.
 */
export async function atomicWrite(
  filePath: string,
  data: string
): Promise<void> {
  const tmp = filePath + ".tmp"
  await fs.promises.writeFile(tmp, data, "utf-8")
  await fs.promises.rename(tmp, filePath)
}
