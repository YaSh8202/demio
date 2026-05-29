import { BrowserWindow, app, dialog, shell } from "electron"
import { copyFile } from "node:fs/promises"
import { basename, join } from "node:path"
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
   * Show a native Save As dialog and copy `srcPath` to the chosen location.
   * Defaults to the Downloads folder. Returns the destination path, or `null` if cancelled.
   */
  exportToDownloads: async (
    event: Electron.IpcMainInvokeEvent,
    srcPath: string,
    suggestedName?: string
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultName = suggestedName || basename(srcPath)
    const defaultPath = join(app.getPath("downloads"), defaultName)

    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath })
      : await dialog.showSaveDialog({ defaultPath })

    if (result.canceled || !result.filePath) return null

    await copyFile(srcPath, result.filePath)
    shell.showItemInFolder(result.filePath)
    return result.filePath
  },
} satisfies NamespaceHandlers
