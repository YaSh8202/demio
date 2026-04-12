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
}

export interface ThreadIndex {
  version: 1
  threads: StoredThread[]
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

export enum MessageStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETE = "complete",
  CANCELLED = "cancelled",
  ERROR = "error",
}

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
