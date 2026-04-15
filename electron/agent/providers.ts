// ── Agent Model Providers ────────────────────────────────────────────────────
//
// Resolves a model ID to an AI SDK LanguageModel instance.
// Supports Anthropic, OpenAI, and Google providers.
//
// Model ID format: "provider:modelId" (e.g. "anthropic:claude-sonnet-4-20250514")
// Legacy bare IDs (no colon) default to Anthropic for backward compatibility.

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { getDecryptedKey } from "../store/provider-keys"

/**
 * Parse a full model ID into provider + model parts.
 */
function parseModelId(fullModelId: string): {
  provider: string
  modelId: string
} {
  const colonIndex = fullModelId.indexOf(":")
  if (colonIndex === -1) {
    // Legacy bare model ID — assume Anthropic
    return { provider: "anthropic", modelId: fullModelId }
  }
  return {
    provider: fullModelId.slice(0, colonIndex),
    modelId: fullModelId.slice(colonIndex + 1),
  }
}

/**
 * Get the env var fallback for a provider.
 */
function getEnvKey(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY
    case "openai":
      return process.env.OPENAI_API_KEY
    case "google":
      return process.env.GOOGLE_API_KEY
    default:
      return undefined
  }
}

/**
 * Create a language model instance from a full model ID.
 *
 * Tries stored provider key first, falls back to env vars.
 */
export function getModel(fullModelId: string) {
  const { provider, modelId } = parseModelId(fullModelId)

  const storedKey = getDecryptedKey(provider)
  const envKey = getEnvKey(provider)
  const apiKey = storedKey || envKey

  if (!apiKey) {
    throw new Error(
      `No API key configured for provider: ${provider}. ` +
        `Add one in Settings or set the appropriate environment variable.`
    )
  }

  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId)
    case "openai":
      return createOpenAI({ apiKey })(modelId)
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId)
    default:
      throw new Error(`Unsupported provider: ${provider}`)
  }
}
