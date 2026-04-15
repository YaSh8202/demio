// ── Model Store (Zustand) ───────────────────────────────────────────────────
//
// Persisted store for the currently selected model.
// Uses localStorage for persistence across sessions.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { LLMProvider } from "@/types/models"
import type { ModelWithProvider } from "@/types/models"

interface ModelStore {
  selectedModel: string // "provider:modelId" format
  selectedProvider: LLMProvider

  setSelectedModel: (fullId: string, provider: LLMProvider) => void
}

export const useModelStore = create<ModelStore>()(
  persist(
    (set) => ({
      selectedModel: "",
      selectedProvider: LLMProvider.ANTHROPIC,

      setSelectedModel: (fullId, provider) =>
        set({ selectedModel: fullId, selectedProvider: provider }),
    }),
    {
      name: "demio:model",
    }
  )
)

/** Get the currently selected model info from the models list. */
export function useSelectedModelInfo(allModels: ModelWithProvider[]) {
  const { selectedModel } = useModelStore()
  return allModels.find((m) => m.fullId === selectedModel) ?? null
}
