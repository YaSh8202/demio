// ── Message Store ────────────────────────────────────────────────────────────
//
// Each thread stores its messages as a JSON array at
// `threads/<tid>/messages.json`. Reads + writes are whole-file (atomic).
// Messages are not cached — per-thread files stay small and the UI already
// reads them eagerly.

import fs from "node:fs"
import log from "../lib/logger"
import type { UIMessage, GetMessagesOptions } from "./types"
import {
  threadDir,
  threadMessagesPath,
  ensureDir,
  atomicWriteSync,
} from "./paths"

function readAll(projectId: string, threadId: string): UIMessage[] {
  const filePath = threadMessagesPath(projectId, threadId)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf-8")
  } catch {
    return []
  }
  if (!raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as UIMessage[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    log.error(`[store] Corrupt messages.json at ${filePath}, returning empty`)
    return []
  }
}

function writeAll(
  projectId: string,
  threadId: string,
  messages: UIMessage[]
): void {
  ensureDir(threadDir(projectId, threadId))
  atomicWriteSync(
    threadMessagesPath(projectId, threadId),
    JSON.stringify(messages, null, 2)
  )
}

/**
 * Read messages with optional pagination.
 */
export function getMessages(
  projectId: string,
  threadId: string,
  opts?: GetMessagesOptions
): UIMessage[] {
  const messages = readAll(projectId, threadId)
  if (!opts) return messages
  const offset = opts.offset ?? 0
  const limit = opts.limit ?? messages.length
  return messages.slice(offset, offset + limit)
}

/**
 * Append a UIMessage. Caller must separately call incrementMessageCount().
 */
export function appendMessage(
  projectId: string,
  threadId: string,
  message: UIMessage
): UIMessage {
  const messages = readAll(projectId, threadId)
  messages.push(message)
  writeAll(projectId, threadId, messages)
  return message
}

/**
 * Update an existing message in place. Returns updated message or null.
 */
export function updateMessage(
  projectId: string,
  threadId: string,
  messageId: string,
  updates: Partial<UIMessage>
): UIMessage | null {
  const messages = readAll(projectId, threadId)
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx === -1) return null
  const updated: UIMessage = { ...messages[idx], ...updates, id: messageId }
  messages[idx] = updated
  writeAll(projectId, threadId, messages)
  return updated
}
