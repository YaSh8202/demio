import { clipboard } from "electron"
import type { NamespaceHandlers } from "../constants"

/**
 * Clipboard IPC handlers.
 *
 * Namespace: "clipboard"
 */
export const clipboardHandlers = {
  /** Read plain text from the system clipboard. */
  readText: async (_event: Electron.IpcMainInvokeEvent) => {
    return clipboard.readText()
  },

  /** Write plain text to the system clipboard. */
  writeText: async (_event: Electron.IpcMainInvokeEvent, text: string) => {
    clipboard.writeText(text)
  },

  /** Read HTML from the system clipboard. */
  readHTML: async (_event: Electron.IpcMainInvokeEvent) => {
    return clipboard.readHTML()
  },

  /** Check if the clipboard has plain-text content. */
  hasText: async (_event: Electron.IpcMainInvokeEvent) => {
    return clipboard.readText().length > 0
  },
} satisfies NamespaceHandlers
