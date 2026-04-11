import { BrowserWindow } from "electron"
import type { EventCallback, NamespaceEvents } from "../constants"

/**
 * UI-related event emitters.
 *
 * Namespace: "ui"
 * Each export is an EventRegister: accepts a broadcast callback,
 * subscribes to native Electron events, returns an unsubscribe fn.
 */
export const uiEvents = {
  /**
   * Fires when any window's maximized state changes.
   * Callback receives `(isMaximized: boolean)`.
   */
  onMaximized: (callback: EventCallback) => {
    const onMaximize = () => callback(true)
    const onUnmaximize = () => callback(false)

    const attach = (win: BrowserWindow) => {
      win.on("maximize", onMaximize)
      win.on("unmaximize", onUnmaximize)
    }

    // Attach to all existing windows
    BrowserWindow.getAllWindows().forEach(attach)

    // Note: the main process calls registerEvents() after window
    // creation, so existing windows are covered. For dynamically
    // created windows, call registerEvents() again.

    return () => {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.off("maximize", onMaximize)
        win.off("unmaximize", onUnmaximize)
      })
    }
  },

  /**
   * Fires when any window gains or loses focus.
   * Callback receives `(isFocused: boolean)`.
   */
  onFocusChanged: (callback: EventCallback) => {
    const onFocus = () => callback(true)
    const onBlur = () => callback(false)

    BrowserWindow.getAllWindows().forEach((win) => {
      win.on("focus", onFocus)
      win.on("blur", onBlur)
    })

    return () => {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.off("focus", onFocus)
        win.off("blur", onBlur)
      })
    }
  },

  /**
   * Fires when any window enters or leaves fullscreen.
   * Callback receives `(isFullScreen: boolean)`.
   */
  onFullScreenChanged: (callback: EventCallback) => {
    const onEnter = () => callback(true)
    const onLeave = () => callback(false)

    BrowserWindow.getAllWindows().forEach((win) => {
      win.on("enter-full-screen", onEnter)
      win.on("leave-full-screen", onLeave)
    })

    return () => {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.off("enter-full-screen", onEnter)
        win.off("leave-full-screen", onLeave)
      })
    }
  },
} satisfies NamespaceEvents
