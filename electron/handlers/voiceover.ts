// ── Voiceover IPC Handlers ───────────────────────────────────────────────────
//
// Read-only ElevenLabs queries used by the renderer's VoiceSelectorPopover.
// Synthesis happens inside the agent tool (electron/agent/tools/voiceover.ts),
// not via these handlers.

import type { NamespaceHandlers } from "../constants"
import { getDecryptedKey } from "../store/provider-keys"
import log from "../lib/logger"

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

interface ElevenLabsVoicesResponse {
  voices?: Array<{
    voice_id: string
    name: string
    preview_url?: string | null
    labels?: Record<string, string>
    description?: string | null
    category?: string | null
  }>
}

export const voiceoverHandlers = {
  /**
   * List the ElevenLabs voices available to the user's account.
   * Returns [] if no ElevenLabs key is configured or the fetch fails.
   */
  listVoices: async (
    _event: Electron.IpcMainInvokeEvent
  ): Promise<DemioVoice[]> => {
    const apiKey = getDecryptedKey("elevenlabs")
    if (!apiKey) return []

    try {
      const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        method: "GET",
        headers: { "xi-api-key": apiKey },
      })
      if (!res.ok) {
        log.warn(`[voiceover] listVoices: status ${res.status}`)
        return []
      }
      const body = (await res.json()) as ElevenLabsVoicesResponse
      return (body.voices ?? []).map((v) => ({
        voiceId: v.voice_id,
        name: v.name,
        previewUrl: v.preview_url ?? null,
        labels: v.labels ?? {},
        description: v.description ?? null,
        category: v.category ?? null,
      }))
    } catch (err) {
      log.error("[voiceover] listVoices failed:", err)
      return []
    }
  },

  /** True when an ElevenLabs key is configured (lets UI gate without exposing the key). */
  hasKey: (_event: Electron.IpcMainInvokeEvent): boolean => {
    return getDecryptedKey("elevenlabs") !== null
  },
} satisfies NamespaceHandlers
