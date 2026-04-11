/**
 * IPC events for agent-browser operations.
 *
 * Namespace: "agentBrowser"
 * Broadcasts progress/status updates from the main process to renderer.
 */

import type { NamespaceEvents, EventCallback } from "../constants"

/**
 * Install progress event.
 *
 * This is a "virtual" event — it doesn't subscribe to any native
 * Electron or OS event. Instead, the `installChrome` handler
 * broadcasts progress lines directly to this channel.
 *
 * The event registrar here is a no-op: it doesn't need to set up
 * any native listener. The preload still needs this entry in the
 * metadata so it creates the `events.agentBrowser.onInstallProgress`
 * subscriber function for the renderer.
 */
export const agentBrowserEvents = {
  onInstallProgress: (_callback: EventCallback) => {
    // No native subscription needed — the handler broadcasts directly.
    // Return a no-op cleanup function.
    return () => {}
  },
} satisfies NamespaceEvents
