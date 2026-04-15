// ── Store Facade ─────────────────────────────────────────────────────────────
//
// Public API for the file-based project store.
// Coordinates projects, threads, and messages modules.
// This is the single import point for the IPC handler layer.

import log from "../lib/logger"
import {
  ensureStoreRoot,
  initProjects,
  listProjects,
  getProject,
  createProject as rawCreateProject,
  updateProject,
  updateProjectMeta,
  deleteProject,
} from "./projects"
import {
  listThreads,
  getThread,
  createThread,
  updateThread,
  deleteThread,
  incrementMessageCount,
  evictThreadCache,
} from "./threads"
import {
  getMessages,
  appendMessage as rawAppendMessage,
  updateMessage,
} from "./messages"
import type {
  StoredProject,
  StoredThread,
  UIMessage,
  ProjectMeta,
  GetMessagesOptions,
} from "./types"

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize the store. Call once on app startup, before registerHandlers().
 * - Ensures ~/.demio/ exists
 * - Loads project index into memory
 */
export function initStore(): void {
  ensureStoreRoot()
  initProjects()
  log.log("[store] Initialized")
}

// ── Re-exports (simple pass-through) ─────────────────────────────────────────

export {
  listProjects,
  getProject,
  updateProject,
  updateProjectMeta,
  deleteProject,
  listThreads,
  getThread,
  createThread,
  updateThread,
  deleteThread,
  getMessages,
  updateMessage,
}

// Re-export types for convenience
export type {
  StoredProject,
  StoredThread,
  UIMessage,
  ProjectMeta,
  GetMessagesOptions,
}

// ── Composite Operations ─────────────────────────────────────────────────────

/**
 * Create a new project with a default "Chat" thread.
 * Sets lastThreadId to the new thread.
 */
export function createProject(
  name: string,
  model?: string
): { project: StoredProject; thread: StoredThread } {
  const project = rawCreateProject(name, model)
  const thread = createThread(project.id, "Chat")
  updateProject(project.id, { lastThreadId: thread.id })
  project.lastThreadId = thread.id
  return { project, thread }
}

/**
 * Append a message to a thread.
 * Handles both the JSONL write and the thread messageCount increment.
 * The caller provides a complete UIMessage (with id, role, parts, metadata).
 */
export function appendMessage(
  projectId: string,
  threadId: string,
  message: UIMessage
): UIMessage {
  const result = rawAppendMessage(projectId, threadId, message)
  incrementMessageCount(projectId, threadId)
  return result
}

/**
 * Delete a project and clean up all caches.
 */
export function deleteProjectFull(projectId: string): boolean {
  evictThreadCache(projectId)
  return deleteProject(projectId)
}
