// ── Provider Keys IPC Handlers ───────────────────────────────────────────────
//
// IPC handler namespace for managing LLM provider API keys.
// Registered as `providerKeys` in allHandlers.
// Mutations broadcast `providerKeys:onKeysChanged` to all windows.

import { BrowserWindow } from "electron"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import {
  getProviderKeys,
  addProviderKey,
  deleteProviderKey,
  validateProviderKey,
} from "../store/provider-keys"

function broadcastKeysChanged() {
  const keys = getProviderKeys()
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(
        DEMIO_EVENT_CHANNEL,
        "providerKeys:onKeysChanged",
        keys
      )
    }
  })
}

export const providerKeysHandlers = {
  getKeys: async (_event: Electron.IpcMainInvokeEvent) => {
    return getProviderKeys()
  },

  addKey: async (
    _event: Electron.IpcMainInvokeEvent,
    provider: string,
    apiKey: string,
    metadata?: Record<string, string>
  ) => {
    const isValid = await validateProviderKey(provider, apiKey, metadata)
    if (!isValid) {
      throw new Error(
        `API key validation failed for ${provider}. Please check your key and try again.`
      )
    }
    const result = addProviderKey(provider, apiKey, metadata)
    broadcastKeysChanged()
    return result
  },

  deleteKey: async (_event: Electron.IpcMainInvokeEvent, id: string) => {
    const result = deleteProviderKey(id)
    broadcastKeysChanged()
    return result
  },

  validateKey: async (
    _event: Electron.IpcMainInvokeEvent,
    provider: string,
    apiKey: string,
    metadata?: Record<string, string>
  ) => {
    const isValid = await validateProviderKey(provider, apiKey, metadata)
    return { isValid }
  },
} satisfies NamespaceHandlers
