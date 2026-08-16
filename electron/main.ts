import { app, BrowserWindow, protocol } from "electron"
import path from "path"
import { config as loadDotenv } from "dotenv"
loadDotenv({ path: [".env.local", ".env"], quiet: true })
// Opt-in CDP port so UI-automation harnesses (agent-browser) can attach to
// the Electron app window for e2e runs. Guarded by env var — a no-op in
// normal runs.
if (process.env.DEMIO_CDP_PORT) {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.DEMIO_CDP_PORT
  )
  // Recent Chromium refuses to open the DevTools protocol server unless a
  // non-implicit --user-data-dir is also present; pass the app's own default
  // path explicitly so behavior/data location is unchanged.
  app.commandLine.appendSwitch("user-data-dir", app.getPath("userData"))
}
import log from "./lib/logger"
import { registerHandlers } from "./handlers"
import { DEMIO_FILE_SCHEME } from "./protocol/demio-file-url"
import { registerDemioFileProtocol } from "./protocol/demio-file"
import { registerEvents } from "./events"
import { getExposedMeta } from "./exposed"
import { initSharedStorage, flushSharedStorage } from "./shared-storage"
import { initStore } from "./store"
import { initProviderKeys } from "./store/provider-keys"
import { initPricing } from "./agent/usage"
import { ensureDaemon, stopDaemon } from "./lib/agent-browser/daemon"
import { enableStream, disableStream } from "./lib/agent-browser/stream"
import { registerSecurityRestrictions } from "./security/restrictions"
import { initPhoenix, shutdownPhoenix } from "./observability/phoenix"

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
    // The thread split has hard px floors: 400px chat + 360px right panel, plus
    // a 256px sidebar = 1016px. Narrower than that and the two floors can't both
    // be honoured, so the layout solver has to violate one.
    minWidth: 1024,
    minHeight: 640,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 16 },
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

// Register custom protocol scheme before app is ready.
//
// Deliberately NOT `standard: true` — that makes Chromium treat the first
// authority component as a host, which gets case-folded and IDNA-normalized.
// A media load is a no-cors request, so an opaque origin is fine.
protocol.registerSchemesAsPrivileged([
  {
    scheme: DEMIO_FILE_SCHEME,
    privileges: { stream: true, supportFetchAPI: true, secure: true },
  },
])

app.on("ready", () => {
  // Initialize Phoenix tracing first so any spans from later init are captured
  initPhoenix()

  // Serve local media over demio-file:// (Range-aware, abort-safe)
  registerDemioFileProtocol()

  // Load persisted shared storage from disk before anything else
  initSharedStorage()

  // Initialize the file-based project store (~/.demio/)
  initStore()

  // Initialize encrypted provider key storage
  initProviderKeys()

  // Warm the models.dev pricing cache so the first run doesn't wait on a fetch
  initPricing()

  // Register the single-channel IPC handler before any windows exist
  registerHandlers()

  // Route external URLs to the system browser instead of new electron windows
  registerSecurityRestrictions()

  // Clean up stale agent-browser sessions from previous crashes
  ensureDaemon()

  // Enable the WebSocket stream server for live browser preview
  enableStream().then((info) => {
    if (info) {
      log.log(`[main] Stream ready at ${info.wsUrl}`)
    } else {
      log.warn("[main] Failed to enable stream on startup")
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

let cleanupDone = false
app.on("before-quit", (event) => {
  if (cleanupDone) return
  event.preventDefault()

  // Disable the stream server before closing sessions
  disableStream()
  // Close all agent-browser sessions and stop the daemon
  stopDaemon()
  // Flush any pending debounced writes to disk before exit
  flushSharedStorage()

  // Flush queued Phoenix spans, but don't hang quit if the collector is slow
  Promise.race([
    shutdownPhoenix(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]).finally(() => {
    cleanupDone = true
    app.quit()
  })
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
    // Re-register events for the new window
    registerEvents()
  }
})
