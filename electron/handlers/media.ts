import { stat } from "node:fs/promises"
import path from "node:path"
import type { NamespaceHandlers } from "../constants"
import {
  allowMediaPath,
  mimeForPath,
  toDemioFileUrl,
} from "../protocol/demio-file-url"

export interface ResolvedMedia {
  url: string
  mime: string
  size: number
  mtimeMs: number
}

/**
 * Media-related IPC handlers.
 *
 * Namespace: "media"
 *
 * URL construction lives here rather than in the renderer because `src/`
 * cannot import runtime code from `electron/`, and a duplicated copy of a
 * security-relevant serialization is how the two drift apart. The renderer
 * treats the returned URL as opaque.
 */
export const mediaHandlers = {
  /**
   * Publish a local media file for playback and return a versioned
   * demio-file:// URL.
   *
   * Returns `null` when the file is missing or zero-length — the latter
   * meaning it is most likely still being written — so the renderer can show
   * an error with a retry rather than handing the player a truncated file.
   */
  resolve: async (
    _event: Electron.IpcMainInvokeEvent,
    absPath: string
  ): Promise<ResolvedMedia | null> => {
    const filePath = path.resolve(absPath)
    try {
      const stats = await stat(filePath)
      if (!stats.isFile() || stats.size === 0) return null
      allowMediaPath(filePath)
      const version = `${Math.round(stats.mtimeMs)}-${stats.size}`
      return {
        url: toDemioFileUrl(filePath, version),
        mime: mimeForPath(filePath),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      }
    } catch {
      return null
    }
  },
} satisfies NamespaceHandlers
