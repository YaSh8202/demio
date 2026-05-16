// ── Store Types ──────────────────────────────────────────────────────────────
//
// Data types for the file-based project store (~/.demio/).
// All dates are ISO 8601 strings for JSON serialization.
// All index files carry a `version` field for future migrations.
//
// Messages use the AI SDK's UIMessage type with custom metadata
// for model info, token usage, and cost tracking.

import type { UIMessage as AISdkUIMessage, LanguageModelUsage } from "ai"

// ── Projects ─────────────────────────────────────────────────────────────────

export interface StoredProject {
  id: string
  name: string
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
  lastThreadId: string | null
  /** Source product domain (e.g. "workik.com"). Used for sidebar favicons. */
  domain?: string | null
}

export interface ProjectIndex {
  version: 1
  projects: StoredProject[]
}

// ── Project Meta ─────────────────────────────────────────────────────────────

export interface ProjectMeta {
  version: 1
  id: string
  selectedModel: string
}

// ── Threads ──────────────────────────────────────────────────────────────────

export interface StoredThread {
  id: string
  title: string
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
  messageCount: number
  /** Parsed product domain (e.g. "cal.com"). Set by the auto-titler. */
  domain?: string | null
}

/** Per-thread meta persisted at threads/<tid>/meta.json. */
export interface ThreadMeta extends StoredThread {
  version: 1
}

/** Ordered list of thread IDs in threads/index.json. */
export interface ThreadIndex {
  version: 1
  threadIds: string[]
}

// ── Messages (AI SDK compatible) ─────────────────────────────────────────────

export type TokenCosts = {
  inputUSD?: number
  outputUSD?: number
  totalUSD?: number
  reasoningUSD?: number
  cacheReadUSD?: number
  cacheWriteUSD?: number
  inputTokenUSD?: number
  outputTokenUSD?: number
  reasoningTokenUSD?: number
  cacheReadsUSD?: number
  cacheWritesUSD?: number
}

export const MessageStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETE: "complete",
  CANCELLED: "cancelled",
  ERROR: "error",
} as const
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus]

export interface MessageMetadata {
  modelId: string | null
  totalUsage: LanguageModelUsage | null
  cost: TokenCosts | null
  status: MessageStatus | null
  messageTokens: number
}

/** AI SDK UIMessage with Demio-specific metadata. */
export type UIMessage = AISdkUIMessage<MessageMetadata>

// ── Pagination ───────────────────────────────────────────────────────────────

export interface GetMessagesOptions {
  limit?: number
  offset?: number
}
