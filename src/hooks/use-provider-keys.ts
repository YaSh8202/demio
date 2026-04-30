// ── useProviderKeys Hook ─────────────────────────────────────────────────────
//
// React Query-based hook for managing LLM provider API keys.
// Subscribes to IPC events for live updates across windows.

import { useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apis, events } from "@/types/electron-api"
import type { ProviderKeyInfo } from "@/types/models"

const QUERY_KEY = ["provider-keys"]

export function useProviderKeys() {
  const queryClient = useQueryClient()

  const { data: keys = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      if (!apis) return []
      return (await apis.providerKeys.getKeys()) as ProviderKeyInfo[]
    },
  })

  // Subscribe to IPC events for cross-window sync
  useEffect(() => {
    const unsub = events?.providerKeys.onKeysChanged(() => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    })
    return () => unsub?.()
  }, [queryClient])

  const addKeyMutation = useMutation({
    mutationFn: async ({
      provider,
      apiKey,
      metadata,
    }: {
      provider: string
      apiKey: string
      metadata?: Record<string, string>
    }): Promise<ProviderKeyInfo> => {
      if (!apis) throw new Error("APIs not available")
      return (await apis.providerKeys.addKey(
        provider,
        apiKey,
        metadata
      )) as ProviderKeyInfo
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })

  const deleteKeyMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!apis) throw new Error("APIs not available")
      return apis.providerKeys.deleteKey(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })

  return {
    keys,
    isLoading,
    addKey: addKeyMutation.mutateAsync,
    addKeyStatus: addKeyMutation.status,
    addKeyError: addKeyMutation.error,
    deleteKey: deleteKeyMutation.mutateAsync,
    deleteKeyStatus: deleteKeyMutation.status,
  }
}
