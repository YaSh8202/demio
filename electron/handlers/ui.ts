import { BrowserWindow, app, shell } from "electron"
import { constants as fsConstants } from "node:fs"
import { copyFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import type { NamespaceHandlers } from "../constants"
import { openExternalSafely } from "../security/open-external"

/**
 * UI-related IPC handlers.
 *
 * Namespace: "ui"
 * Covers window management and shell operations.
 */
export const uiHandlers = {
  /** Open a URL in the user's default browser. */
  openExternal: async (_event: Electron.IpcMainInvokeEvent, url: string) => {
    await openExternalSafely(url)
  },

  /** Returns whether the sender's window is maximized. */
  isMaximized: async (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  },

  /** Toggle maximize / restore for the sender's window. */
  toggleMaximize: async (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  },

  /** Minimize the sender's window. */
  minimize: async (event: Electron.IpcMainInvokeEvent) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  },

  /** Close the sender's window. */
  close: async (event: Electron.IpcMainInvokeEvent) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  },

  /** Returns whether the sender's window is focused. */
  isFocused: async (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  },

  /** Returns whether the sender's window is fullscreen. */
  isFullScreen: async (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFullScreen() ?? false
  },

  /** Toggle fullscreen for the sender's window. */
  toggleFullScreen: async (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.setFullScreen(!win.isFullScreen())
  },

  /**
   * Copy a file at `srcPath` into the user's Downloads folder.
   * Picks a unique filename if a collision exists. Reveals the copy in Finder/Explorer.
   * Returns the destination path.
   */
  exportToDownloads: async (
    _event: Electron.IpcMainInvokeEvent,
    srcPath: string,
    suggestedName?: string
  ) => {
    const downloadsDir = app.getPath("downloads")
    const original = suggestedName || basename(srcPath)
    const ext = extname(original)
    const stem = original.slice(0, original.length - ext.length)

    let destPath = join(downloadsDir, original)
    let counter = 1
    while (true) {
      try {
        await copyFile(srcPath, destPath, fsConstants.COPYFILE_EXCL)
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
        destPath = join(downloadsDir, `${stem} (${counter})${ext}`)
        counter += 1
      }
    }

    shell.showItemInFolder(destPath)
    return destPath
  },
} satisfies NamespaceHandlers
