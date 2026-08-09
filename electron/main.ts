import { app, BrowserWindow, protocol } from "electron"
import path from "path"
import { createReadStream, statSync } from "fs"
import { Readable } from "stream"
import type { ReadableStream as NodeReadableStream } from "stream/web"
import { config as loadDotenv } from "dotenv"
loadDotenv({ path: [".env.local", ".env"], quiet: true })
// Opt-in CDP port so UI-automation harnesses (agent-browser) can attach to
// the Electron app window for e2e runs. Guarded by env var — a no-op in
// normal runs.
if (process.env.DEMIO_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.DEMIO_CDP_PORT)
  // Recent Chromium refuses to open the DevTools protocol server unless a
  // non-implicit --user-data-dir is also present; pass the app's own default
  // path explicitly so behavior/data location is unchanged.
  app.commandLine.appendSwitch("user-data-dir", app.getPath("userData"))
}
import log from "./lib/logger"
import { registerHandlers } from "./handlers"
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

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
}

function mimeForPath(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
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

// Register custom protocol scheme before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: "demio-file",
    privileges: { stream: true, supportFetchAPI: true },
  },
])

app.on("ready", () => {
  // Initialize Phoenix tracing first so any spans from later init are captured
  initPhoenix()

  // Register demio-file:// protocol for serving local files (videos, etc.)
  protocol.handle("demio-file", (req) => {
    const filePath = decodeURIComponent(new URL(req.url).pathname)
    const stat = statSync(filePath)
    const fileSize = stat.size
    const contentType = mimeForPath(filePath)

    const range = req.headers.get("range")
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        const chunkSize = end - start + 1
        const stream = createReadStream(filePath, { start, end })
        return new Response(
          Readable.toWeb(stream) as unknown as NodeReadableStream,
          {
            status: 206,
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(chunkSize),
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Accept-Ranges": "bytes",
            },
          }
        )
      }
    }

    const stream = createReadStream(filePath)
    return new Response(
      Readable.toWeb(stream) as unknown as NodeReadableStream,
      {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
        },
      }
    )
  })

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
