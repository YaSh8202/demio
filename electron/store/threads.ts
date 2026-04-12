// ── Thread Store ─────────────────────────────────────────────────────────────
//
// Manages per-project thread indices (threads/index.json).
// Thread indices are cached in memory per-project after first load.

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { StoredThread, ThreadIndex } from "./types"
import {
  threadIndexPath,
  threadsDir,
  threadMessagesPath,
  ensureDir,
  atomicWriteSync,
} from "./paths"

// ── In-memory cache (per project) ────────────────────────────────────────────

const cache = new Map<string, ThreadIndex>()

function emptyIndex(): ThreadIndex {
  return { version: 1, threads: [] }
}

// ── Read / Write ─────────────────────────────────────────────────────────────

function readIndex(projectId: string): ThreadIndex {
  const cached = cache.get(projectId)
  if (cached) return cached

  const filePath = threadIndexPath(projectId)
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const index = JSON.parse(raw) as ThreadIndex
    cache.set(projectId, index)
    return index
  } catch {
    const index = emptyIndex()
    cache.set(projectId, index)
    return index
  }
}

function writeIndex(projectId: string, index: ThreadIndex): void {
  cache.set(projectId, index)
  const filePath = threadIndexPath(projectId)
  ensureDir(path.dirname(filePath))
  atomicWriteSync(filePath, JSON.stringify(index, null, 2))
}

// ── Public API ───────────────────────────────────────────────────────────────

/** List all threads for a project. */
export function listThreads(projectId: string): StoredThread[] {
  return readIndex(projectId).threads
}

/** Get a single thread by ID. */
export function getThread(
  projectId: string,
  threadId: string
): StoredThread | null {
  const index = readIndex(projectId)
  return index.threads.find((t) => t.id === threadId) ?? null
}

/**
 * Create a new thread.
 * Creates an empty .jsonl file for messages.
 * Returns the new thread.
 */
export function createThread(projectId: string, title?: string): StoredThread {
  const now = new Date().toISOString()
  const id = randomUUID()

  const thread: StoredThread = {
    id,
    title: title ?? "Chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  }

  // Ensure threads directory exists
  ensureDir(threadsDir(projectId))

  // Create empty .jsonl file
  fs.writeFileSync(threadMessagesPath(projectId, id), "", "utf-8")

  // Add to index
  const index = readIndex(projectId)
  index.threads.unshift(thread)
  writeIndex(projectId, index)

  return thread
}

/**
 * Update a thread's fields (title).
 * Returns the updated thread, or null if not found.
 */
export function updateThread(
  projectId: string,
  threadId: string,
  updates: Partial<Pick<StoredThread, "title">>
): StoredThread | null {
  const index = readIndex(projectId)
  const thread = index.threads.find((t) => t.id === threadId)
  if (!thread) return null

  if (updates.title !== undefined) thread.title = updates.title
  thread.updatedAt = new Date().toISOString()

  writeIndex(projectId, index)
  return thread
}

/**
 * Increment the message count for a thread and update its timestamp.
 * Called internally when a message is appended.
 */
export function incrementMessageCount(
  projectId: string,
  threadId: string
): void {
  const index = readIndex(projectId)
  const thread = index.threads.find((t) => t.id === threadId)
  if (!thread) return

  thread.messageCount += 1
  thread.updatedAt = new Date().toISOString()
  writeIndex(projectId, index)
}

/**
 * Delete a thread and its message file.
 * Returns true if deleted, false if not found.
 */
export function deleteThread(projectId: string, threadId: string): boolean {
  const index = readIndex(projectId)
  const idx = index.threads.findIndex((t) => t.id === threadId)
  if (idx === -1) return false

  index.threads.splice(idx, 1)
  writeIndex(projectId, index)

  // Remove the .jsonl file
  try {
    fs.unlinkSync(threadMessagesPath(projectId, threadId))
  } catch {
    // File may not exist — that's fine
  }

  return true
}

/** Evict a project's thread index from cache. */
export function evictThreadCache(projectId: string): void {
  cache.delete(projectId)
}

/** Clear all cached thread indices. */
export function resetThreadCache(): void {
  cache.clear()
}
