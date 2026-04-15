export interface ModelInfo {
  id: string // "provider:modelId" format
  name: string
}

export interface ModelGroup {
  provider: "openai" | "anthropic" | "google"
  models: ModelInfo[]
}

/** Hardcoded fallback models (used when models.dev is unavailable). */
export const MODELS: ModelGroup[] = [
  {
    provider: "openai",
    models: [
      { id: "openai:gpt-4o", name: "GPT-4o" },
      { id: "openai:gpt-4o-mini", name: "GPT-4o Mini" },
    ],
  },
  {
    provider: "anthropic",
    models: [
      { id: "anthropic:claude-opus-4-20250514", name: "Claude Opus 4" },
      { id: "anthropic:claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    ],
  },
  {
    provider: "google",
    models: [
      { id: "google:gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "google:gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
]

export function getModelName(fullModelId: string): string {
  for (const group of MODELS) {
    const found = group.models.find((m) => m.id === fullModelId)
    if (found) return found.name
  }
  // Strip provider prefix for display
  const colonIndex = fullModelId.indexOf(":")
  return colonIndex > -1 ? fullModelId.slice(colonIndex + 1) : fullModelId
}
