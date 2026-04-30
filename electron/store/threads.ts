// ── Thread Store ─────────────────────────────────────────────────────────────
//
// Each thread has its own directory `threads/<tid>/` containing:
//   - meta.json       (ThreadMeta)
//   - messages.json   (UIMessage[])
//
// `threads/index.json` keeps only an ordered list of thread IDs, so per-thread
// title / timestamp updates don't rewrite a shared file.

import fs from "node:fs"
import { randomUUID } from "node:crypto"
import type { StoredThread, ThreadIndex, ThreadMeta } from "./types"
import {
  threadIndexPath,
  threadDir,
  threadsDir,
  threadMetaPath,
  threadMessagesPath,
  ensureDir,
  atomicWriteSync,
} from "./paths"

// ── In-memory caches ─────────────────────────────────────────────────────────

/** threads/index.json per project. */
const indexCache = new Map<string, ThreadIndex>()
/** threads/<tid>/meta.json. Keyed by `${projectId}:${threadId}`. */
const metaCache = new Map<string, ThreadMeta>()

function metaKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

function emptyIndex(): ThreadIndex {
  return { version: 1, threadIds: [] }
}

// ── Index read / write ──────────────────────────────────────────────────────

function readIndex(projectId: string): ThreadIndex {
  const cached = indexCache.get(projectId)
  if (cached) return cached

  const filePath = threadIndexPath(projectId)
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const index = JSON.parse(raw) as ThreadIndex
    indexCache.set(projectId, index)
    return index
  } catch {
    const index = emptyIndex()
    indexCache.set(projectId, index)
    return index
  }
}

function writeIndex(projectId: string, index: ThreadIndex): void {
  indexCache.set(projectId, index)
  ensureDir(threadsDir(projectId))
  atomicWriteSync(threadIndexPath(projectId), JSON.stringify(index, null, 2))
}

// ── Meta read / write ───────────────────────────────────────────────────────

function readMeta(projectId: string, threadId: string): ThreadMeta | null {
  const key = metaKey(projectId, threadId)
  const cached = metaCache.get(key)
  if (cached) return cached

  try {
    const raw = fs.readFileSync(threadMetaPath(projectId, threadId), "utf-8")
    const meta = JSON.parse(raw) as ThreadMeta
    metaCache.set(key, meta)
    return meta
  } catch {
    return null
  }
}

function writeMeta(projectId: string, meta: ThreadMeta): void {
  metaCache.set(metaKey(projectId, meta.id), meta)
  ensureDir(threadDir(projectId, meta.id))
  atomicWriteSync(
    threadMetaPath(projectId, meta.id),
    JSON.stringify(meta, null, 2)
  )
}

// ── Public API ───────────────────────────────────────────────────────────────

/** List all threads for a project (reads per-thread meta.json). */
export function listThreads(projectId: string): StoredThread[] {
  const index = readIndex(projectId)
  const threads: StoredThread[] = []
  for (const id of index.threadIds) {
    const meta = readMeta(projectId, id)
    if (meta) threads.push(metaToThread(meta))
  }
  return threads
}

/** Get a single thread by ID. */
export function getThread(
  projectId: string,
  threadId: string
): StoredThread | null {
  const meta = readMeta(projectId, threadId)
  return meta ? metaToThread(meta) : null
}

function metaToThread(meta: ThreadMeta): StoredThread {
  const { version: _v, ...rest } = meta
  return rest
}

/** Create a new thread. */
export function createThread(projectId: string, title?: string): StoredThread {
  const now = new Date().toISOString()
  const id = randomUUID()

  const meta: ThreadMeta = {
    version: 1,
    id,
    title: title ?? "Chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    domain: null,
  }

  ensureDir(threadDir(projectId, id))

  // Write meta + empty messages
  writeMeta(projectId, meta)
  atomicWriteSync(threadMessagesPath(projectId, id), "[]")

  // Prepend to index
  const index = readIndex(projectId)
  index.threadIds.unshift(id)
  writeIndex(projectId, index)

  return metaToThread(meta)
}

/** Update a thread's fields (title, domain). Returns updated thread or null. */
export function updateThread(
  projectId: string,
  threadId: string,
  updates: Partial<Pick<StoredThread, "title" | "domain">>
): StoredThread | null {
  const meta = readMeta(projectId, threadId)
  if (!meta) return null

  if (updates.title !== undefined) meta.title = updates.title
  if (updates.domain !== undefined) meta.domain = updates.domain
  meta.updatedAt = new Date().toISOString()

  writeMeta(projectId, meta)
  return metaToThread(meta)
}

/** Increment messageCount and bump updatedAt. */
export function incrementMessageCount(
  projectId: string,
  threadId: string
): void {
  const meta = readMeta(projectId, threadId)
  if (!meta) return

  meta.messageCount += 1
  meta.updatedAt = new Date().toISOString()
  writeMeta(projectId, meta)
}

/** Delete a thread and its entire directory. */
export function deleteThread(projectId: string, threadId: string): boolean {
  const index = readIndex(projectId)
  const idx = index.threadIds.indexOf(threadId)
  if (idx === -1) return false

  index.threadIds.splice(idx, 1)
  writeIndex(projectId, index)

  metaCache.delete(metaKey(projectId, threadId))

  try {
    fs.rmSync(threadDir(projectId, threadId), { recursive: true, force: true })
  } catch {
    // dir may not exist
  }

  return true
}

/** Evict a project's thread caches. */
export function evictThreadCache(projectId: string): void {
  indexCache.delete(projectId)
  for (const key of metaCache.keys()) {
    if (key.startsWith(`${projectId}:`)) metaCache.delete(key)
  }
}

/** Clear all cached thread data. */
export function resetThreadCache(): void {
  indexCache.clear()
  metaCache.clear()
}
