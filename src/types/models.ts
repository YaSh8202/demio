// ── LLM Provider & Model Types ──────────────────────────────────────────────
//
// Shared types for multi-provider model support.
// Used by both renderer (model selector UI) and main process (agent).

import type { ProviderModel } from "@tokenlens/core"

export const LLMProvider = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  GOOGLE: "google",
  AMAZON_BEDROCK: "amazon-bedrock",
  ELEVENLABS: "elevenlabs",
} as const

export type LLMProvider = (typeof LLMProvider)[keyof typeof LLMProvider]

export const LLM_PROVIDER_NAMES: Record<LLMProvider, string> = {
  [LLMProvider.OPENAI]: "OpenAI",
  [LLMProvider.ANTHROPIC]: "Anthropic",
  [LLMProvider.GOOGLE]: "Google",
  [LLMProvider.AMAZON_BEDROCK]: "Amazon Bedrock",
  [LLMProvider.ELEVENLABS]: "ElevenLabs",
}

/**
 * Providers backing real text-generation models (excludes voice/TTS providers).
 * The model selector should ignore non-LLM provider keys when deciding whether
 * any LLM is configured.
 */
export const LLM_TEXT_PROVIDERS: ReadonlySet<LLMProvider> = new Set([
  LLMProvider.OPENAI,
  LLMProvider.ANTHROPIC,
  LLMProvider.GOOGLE,
  LLMProvider.AMAZON_BEDROCK,
])

/** Model with provider context, extended from models.dev data */
export interface ModelWithProvider extends ProviderModel {
  provider: LLMProvider
  providerName: string
  /** Format: "provider:modelId" */
  fullId: string
}

/** Processed models data from models.dev */
export interface ModelsData {
  providers: Array<{
    id: LLMProvider
    name: string
    models: ModelWithProvider[]
  }>
  allModels: ModelWithProvider[]
}

/** Provider key info exposed to the renderer (no decrypted key) */
export interface ProviderKeyInfo {
  id: string
  provider: LLMProvider
  isValid: boolean
  createdAt: string
  updatedAt: string
  /** Non-secret per-provider config (e.g. AWS region for Bedrock). */
  metadata?: Record<string, string>
}
