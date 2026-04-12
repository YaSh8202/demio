export interface ModelInfo {
  id: string
  name: string
}

export interface ModelGroup {
  provider: "openai" | "anthropic" | "google"
  models: ModelInfo[]
}

export const MODELS: ModelGroup[] = [
  {
    provider: "openai",
    models: [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    ],
  },
  {
    provider: "anthropic",
    models: [
      { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    ],
  },
  {
    provider: "google",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
]

export function getModelName(modelId: string): string {
  for (const group of MODELS) {
    const found = group.models.find((m) => m.id === modelId)
    if (found) return found.name
  }
  return modelId
}
