// ── useModels Hook ──────────────────────────────────────────────────────────
//
// Fetches model data from models.dev via React Query.
// 24h cache, 2 retries with exponential backoff.

import { useQuery } from "@tanstack/react-query"
import { useCallback } from "react"
import { getModelsData } from "@/lib/models-dev"
import type { ModelsData } from "@/types/models"

const FALLBACK: ModelsData = { providers: [], allModels: [] }

export function useModels() {
  const { data, error, isLoading } = useQuery({
    queryKey: ["models"],
    queryFn: getModelsData,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
  })

  if (error) {
    console.error("Failed to load models data:", error)
  }

  const getModel = useCallback(
    (fullId: string) => data?.allModels.find((m) => m.fullId === fullId),
    [data]
  )

  return {
    ...(data ?? FALLBACK),
    getModel,
    isLoading,
    error,
  }
}
