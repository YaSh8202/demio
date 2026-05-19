// ── Models.dev Integration ──────────────────────────────────────────────────
//
// Fetches model data from models.dev via the tokenlens library.
// Processing: filter embeddings, sort by release date, map to our types.
// Caching is handled by React Query in the consuming hook.

import type { ProviderInfo } from "@tokenlens/core"
import { fetchModels } from "tokenlens"
import { LLMProvider } from "@/types/models"
import type { ModelsData, ModelWithProvider } from "@/types/models"

/**
 * Map our provider values to models.dev provider IDs.
 * ElevenLabs isn't a text-model provider — it has no models.dev entry — so
 * it maps to an empty string and is filtered out below.
 */
const PROVIDER_ID_MAP: Record<LLMProvider, string> = {
  [LLMProvider.OPENAI]: "openai",
  [LLMProvider.ANTHROPIC]: "anthropic",
  [LLMProvider.GOOGLE]: "google",
  [LLMProvider.AMAZON_BEDROCK]: "amazon-bedrock",
  [LLMProvider.ELEVENLABS]: "",
}

function sortModelsByDate(models: ModelWithProvider[]): ModelWithProvider[] {
  return models.sort((a, b) => {
    const dateA = new Date(a.release_date ?? 0).getTime()
    const dateB = new Date(b.release_date ?? 0).getTime()
    return dateB - dateA
  })
}

export function processModelsDevData(modelsDevData: {
  [key: string]: ProviderInfo
}): ModelsData {
  const providers: ModelsData["providers"] = []
  const allModels: ModelWithProvider[] = []

  for (const providerId of Object.values(LLMProvider)) {
    const modelsDevId = PROVIDER_ID_MAP[providerId]
    if (!modelsDevId) continue
    const providerData = modelsDevData[modelsDevId]

    if (!providerData) continue

    const providerModels = Object.entries(providerData.models).map(
      ([modelId, modelData]) =>
        ({
          ...modelData,
          provider: providerId,
          providerName: providerData.name,
          fullId: `${providerId}:${modelId}`,
        }) as ModelWithProvider
    )

    const sortedModels = sortModelsByDate(providerModels).filter(
      (m) => !m.id.includes("embedding")
    )

    providers.push({
      id: providerId,
      name: providerData.name || providerData.id,
      models: sortedModels,
    })

    allModels.push(...sortedModels)
  }

  return {
    providers,
    allModels: sortModelsByDate(allModels),
  }
}

export async function getModelsData(): Promise<ModelsData> {
  const modelsDevData = await fetchModels()
  return processModelsDevData(modelsDevData)
}
