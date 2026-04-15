import { app, BrowserWindow } from "electron"
import path from "path"
import { registerHandlers } from "./handlers"
import { registerEvents } from "./events"
import { getExposedMeta } from "./exposed"
import { initSharedStorage, flushSharedStorage } from "./shared-storage"
import { initStore } from "./store"
import { initProviderKeys } from "./store/provider-keys"
import { ensureDaemon, stopDaemon } from "./lib/agent-browser/daemon"
import { enableStream, disableStream } from "./lib/agent-browser/stream"

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

/**
 * Build the `additionalArguments` array that the preload script
 * will parse to auto-generate IPC wrappers.
 */
function getWindowAdditionalArguments() {
  const meta = getExposedMeta()
  return [
    `--main-exposed-meta=${JSON.stringify(meta)}`,
    `--window-name=main`,
    `--app-version=${app.getVersion()}`,
  ]
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for preload to access process.argv
      additionalArguments: getWindowAdditionalArguments(),
    },
  })

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    )
  }

  return mainWindow
}

app.on("ready", () => {
  // Load persisted shared storage from disk before anything else
  initSharedStorage()

  // Initialize the file-based project store (~/.demio/)
  initStore()

  // Initialize encrypted provider key storage
  initProviderKeys()

  // Register the single-channel IPC handler before any windows exist
  registerHandlers()

  // Clean up stale agent-browser sessions from previous crashes
  ensureDaemon()

  // Enable the WebSocket stream server for live browser preview
  enableStream().then((info) => {
    if (info) {
      console.log(`[main] Stream ready at ${info.wsUrl}`)
    } else {
      console.warn("[main] Failed to enable stream on startup")
    }
  })

  createWindow()

  // Register event broadcasters after windows exist so they can
  // attach native event listeners to BrowserWindow instances
  registerEvents()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", () => {
  // Disable the stream server before closing sessions
  disableStream()
  // Close all agent-browser sessions and stop the daemon
  stopDaemon()
  // Flush any pending debounced writes to disk before exit
  flushSharedStorage()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
    // Re-register events for the new window
    registerEvents()
  }
})
