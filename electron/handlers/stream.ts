/**
 * IPC handlers for browser stream management.
 *
 * Namespace: "stream"
 * Controls the agent-browser WebSocket stream server and
 * exposes the stream URL to the renderer process.
 */

import type { NamespaceHandlers } from "../constants"
import {
  enableStream,
  disableStream,
  getStreamStatus,
  refreshStream,
} from "../lib/agent-browser/stream"
import type { StreamInfo } from "../lib/agent-browser/stream"

export const streamHandlers = {
  /**
   * Enable the WebSocket stream server.
   * Tries port 9223 first, retries on conflict.
   *
   * @returns StreamInfo with port + wsUrl, or null on failure.
   */
  enable: async (
    _event: Electron.IpcMainInvokeEvent
  ): Promise<StreamInfo | null> => {
    return enableStream()
  },

  /**
   * Disable the WebSocket stream server.
   */
  disable: async (_event: Electron.IpcMainInvokeEvent): Promise<void> => {
    return disableStream()
  },

  /**
   * Get the current stream WebSocket URL.
   * Queries agent-browser if no cached value exists.
   *
   * @returns The ws:// URL string, or null if streaming is not active.
   */
  getUrl: async (
    _event: Electron.IpcMainInvokeEvent
  ): Promise<string | null> => {
    const info = await getStreamStatus()
    return info?.wsUrl ?? null
  },

  /**
   * Force a fresh stream enable. Called by the renderer when its WebSocket
   * keeps failing to reconnect (daemon was killed/restarted by agent commands).
   *
   * Invalidates the cached URL and re-enables the stream server, returning
   * the (possibly new) StreamInfo.
   */
  refresh: async (
    _event: Electron.IpcMainInvokeEvent
  ): Promise<StreamInfo | null> => {
    return refreshStream()
  },
} satisfies NamespaceHandlers
