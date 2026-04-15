// ── Message Store ────────────────────────────────────────────────────────────
//
// Manages per-thread messages stored as JSONL (one JSON object per line).
// Messages use the AI SDK's UIMessage type with Demio-specific metadata.
// Messages are NOT cached — always read from disk (per-thread files are small).
// Appends use fs.appendFileSync for efficiency (no file rewrite).
// Updates rewrite the full file (infrequent — only for status/metadata patches).

import fs from "node:fs"
import log from "../lib/logger"
import type { UIMessage, GetMessagesOptions } from "./types"
import {
  threadMessagesPath,
  ensureDir,
  threadsDir,
  atomicWriteSync,
} from "./paths"

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read all messages from a thread's .jsonl file.
 * Supports optional limit/offset for pagination.
 */
export function getMessages(
  projectId: string,
  threadId: string,
  opts?: GetMessagesOptions
): UIMessage[] {
  const filePath = threadMessagesPath(projectId, threadId)

  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf-8")
  } catch {
    return []
  }

  if (!raw.trim()) return []

  const lines = raw.trim().split("\n")
  let messages: UIMessage[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line) as UIMessage)
    } catch {
      log.error(`[store] Corrupt JSONL line in ${filePath}, skipping`)
    }
  }

  // Apply pagination
  if (opts) {
    const offset = opts.offset ?? 0
    const limit = opts.limit ?? messages.length
    messages = messages.slice(offset, offset + limit)
  }

  return messages
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Append a UIMessage to a thread's .jsonl file.
 * The caller is responsible for constructing a complete UIMessage
 * (with id, role, parts, and optional metadata).
 *
 * Note: This does NOT update the thread's messageCount.
 * The caller (store facade / handler) must call incrementMessageCount() separately.
 */
export function appendMessage(
  projectId: string,
  threadId: string,
  message: UIMessage
): UIMessage {
  const filePath = threadMessagesPath(projectId, threadId)

  // Ensure the threads directory exists (in case of first write)
  ensureDir(threadsDir(projectId))

  // Append as a single JSONL line
  fs.appendFileSync(filePath, JSON.stringify(message) + "\n", "utf-8")

  return message
}

/**
 * Update an existing message in a thread's .jsonl file.
 * Reads all messages, patches the matching one, and rewrites the file.
 * Used for updating metadata (status, usage, cost) after streaming completes.
 *
 * Returns the updated message, or null if not found.
 */
export function updateMessage(
  projectId: string,
  threadId: string,
  messageId: string,
  updates: Partial<UIMessage>
): UIMessage | null {
  const filePath = threadMessagesPath(projectId, threadId)
  const messages = getMessages(projectId, threadId)

  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx === -1) return null

  // Merge updates into the message
  const updated: UIMessage = { ...messages[idx], ...updates, id: messageId }
  messages[idx] = updated

  // Rewrite the full file
  const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n"
  atomicWriteSync(filePath, content)

  return updated
}
