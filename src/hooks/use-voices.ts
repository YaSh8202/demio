// ── useVoices Hook ───────────────────────────────────────────────────────────
//
// React Query-based hook for fetching the ElevenLabs voice list and the
// "is an ElevenLabs key configured?" flag. Invalidates whenever provider keys
// change (so adding/removing the ElevenLabs key refetches).

import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apis, events } from "@/types/electron-api"

export interface DemioVoice {
  voiceId: string
  name: string
  previewUrl: string | null
  labels: {
    accent?: string
    age?: string
    gender?: string
    descriptive?: string
    use_case?: string
  }
  description?: string | null
  category?: string | null
}

const VOICES_KEY = ["voices"]
const HAS_KEY_KEY = ["voices", "hasKey"]

export function useVoices() {
  const queryClient = useQueryClient()

  const { data: hasKey = false, isLoading: hasKeyLoading } = useQuery({
    queryKey: HAS_KEY_KEY,
    queryFn: async (): Promise<boolean> => {
      if (!apis) return false
      return (await apis.voiceover.hasKey()) as boolean
    },
  })

  const { data: voices = [], isLoading: voicesLoading } = useQuery({
    queryKey: VOICES_KEY,
    enabled: hasKey,
    queryFn: async (): Promise<DemioVoice[]> => {
      if (!apis) return []
      return (await apis.voiceover.listVoices()) as DemioVoice[]
    },
  })

  // Refetch on provider-key changes (e.g. user just added the ElevenLabs key).
  useEffect(() => {
    const unsub = events?.providerKeys.onKeysChanged(() => {
      queryClient.invalidateQueries({ queryKey: HAS_KEY_KEY })
      queryClient.invalidateQueries({ queryKey: VOICES_KEY })
    })
    return () => unsub?.()
  }, [queryClient])

  return {
    voices,
    hasKey,
    isLoading: hasKeyLoading || (hasKey && voicesLoading),
  }
}
