/**
 * IPC handlers for agent-browser operations.
 *
 * Namespace: "agentBrowser"
 * Exposes browser automation commands to the renderer process.
 */

import { BrowserWindow } from "electron"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import { execAgentBrowser } from "../lib/agent-browser/exec"
import type { ExecResult } from "../lib/agent-browser/exec"
import { checkChrome, installChrome } from "../lib/agent-browser/chrome"
import type { ChromeStatus, InstallResult } from "../lib/agent-browser/chrome"

export const agentBrowserHandlers = {
  /**
   * Execute one or more agent-browser commands.
   *
   * @param commands Array of command strings
   * @param timeout Optional timeout in ms (default 30s)
   * @returns ExecResult with output, error, exitCode, etc.
   */
  exec: async (
    _event: Electron.IpcMainInvokeEvent,
    commands: string[],
    timeout?: number
  ): Promise<ExecResult> => {
    return execAgentBrowser(commands, { timeout })
  },

  /**
   * Check whether Chrome/Chromium is available for agent-browser.
   *
   * @returns ChromeStatus with available flag and version.
   */
  checkChromeStatus: async (
    _event: Electron.IpcMainInvokeEvent
  ): Promise<ChromeStatus> => {
    return checkChrome()
  },

  /**
   * Install Chrome for agent-browser.
   *
   * Streams progress lines to the renderer via the
   * `agentBrowser:onInstallProgress` event channel.
   *
   * @returns InstallResult with ok flag and final message.
   */
  installChrome: async (
    _event: Electron.IpcMainInvokeEvent
  ): Promise<InstallResult> => {
    const broadcast = (line: string) => {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send(
            DEMIO_EVENT_CHANNEL,
            "agentBrowser:onInstallProgress",
            line
          )
        }
      })
    }

    return installChrome(broadcast)
  },
} satisfies NamespaceHandlers
