import fs from "node:fs"
import path from "node:path"
import { app, BrowserWindow } from "electron"
import type { NamespaceHandlers } from "./constants"
import { DEMIO_EVENT_CHANNEL } from "./constants"

/**
 * Main-process shared storage.
 *
 * Persistent JSON-backed key-value store (inspired by AFFiNE's
 * PersistentJSONFileStorage) that:
 * 1. Loads synchronously from disk on startup
 * 2. Debounces writes (1s) so rapid mutations collapse into one I/O
 * 3. Broadcasts changes to all renderer windows
 * 4. Tags each mutation with a `clientId` so the originating
 *    renderer can skip its own echoed broadcast
 */

// ---------------------------------------------------------------------------
// Persistent JSON file storage
// ---------------------------------------------------------------------------

const STORAGE_FILENAME = "global-state.json"

/** In-memory data — authoritative source of truth after initial load. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-serialized values are inherently untyped
let data: Record<string, any> = {}

/** Resolved file path (set in `initSharedStorage`). */
let filepath = ""

/** Load state synchronously from disk. Call once before any windows open. */
export function initSharedStorage() {
  filepath = path.join(app.getPath("userData"), STORAGE_FILENAME)
  try {
    data = JSON.parse(fs.readFileSync(filepath, "utf-8"))
  } catch (err: unknown) {
    // Ignore missing file (first launch), log anything else
    if (
      !(
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "ENOENT"
      )
    ) {
      console.error("[shared-storage] Failed to load:", err)
    }
  }
}

// ---------------------------------------------------------------------------
// Debounced disk persistence
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null
let writeInProgress = false
let pendingWrite = false

const DEBOUNCE_MS = 1000
const MAX_RETRIES = 3

async function writeToDisk(retries = 0): Promise<void> {
  try {
    await fs.promises.writeFile(
      filepath,
      JSON.stringify(data, null, 2),
      "utf-8"
    )
  } catch (err) {
    if (retries < MAX_RETRIES) {
      // Exponential backoff: 200ms, 400ms, 800ms
      const delay = 200 * Math.pow(2, retries)
      await new Promise((r) => setTimeout(r, delay))
      return writeToDisk(retries + 1)
    }
    console.error("[shared-storage] Failed to persist after retries:", err)
  }
}

/**
 * Schedule a debounced write. Multiple rapid calls within DEBOUNCE_MS
 * collapse into a single I/O. If a write is already in progress,
 * the latest state will be flushed after it completes.
 */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    saveTimer = null
    if (writeInProgress) {
      // A write is running — flag that we need another after it finishes
      pendingWrite = true
      return
    }
    writeInProgress = true
    await writeToDisk()
    writeInProgress = false
    // If more changes came in while writing, flush again
    if (pendingWrite) {
      pendingWrite = false
      scheduleSave()
    }
  }, DEBOUNCE_MS)
}

/** Flush immediately (call on app quit). */
export function flushSharedStorage() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8")
  } catch (err) {
    console.error("[shared-storage] Failed to flush on quit:", err)
  }
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

function broadcastChange(key: string, value: unknown, sourceClientId: string) {
  const payload: Record<string, { v: unknown; s: string }> = {
    [key]: { v: value, s: sourceClientId },
  }

  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(
        DEMIO_EVENT_CHANNEL,
        "sharedStorage:onGlobalStateChanged",
        payload
      )
    }
  })
}

// ---------------------------------------------------------------------------
// IPC handler namespace: "sharedStorage"
// ---------------------------------------------------------------------------

export const sharedStorageHandlers = {
  /** Get the entire global state (used for sync init in preload). */
  getAllGlobalState: (_event: Electron.IpcMainInvokeEvent) => {
    return { ...data }
  },

  /** Get a single key. */
  getGlobalState: (_event: Electron.IpcMainInvokeEvent, key: string) => {
    return data[key] ?? null
  },

  /** Set a key, persist, and broadcast. */
  setGlobalState: (
    _event: Electron.IpcMainInvokeEvent,
    key: string,
    value: unknown,
    clientId: string
  ) => {
    data[key] = value
    scheduleSave()
    broadcastChange(key, value, clientId)
  },

  /** Delete a key, persist, and broadcast. */
  deleteGlobalState: (
    _event: Electron.IpcMainInvokeEvent,
    key: string,
    clientId: string
  ) => {
    delete data[key]
    scheduleSave()
    broadcastChange(key, undefined, clientId)
  },

  /** Clear all state, persist, and broadcast. */
  clearGlobalState: (_event: Electron.IpcMainInvokeEvent, clientId: string) => {
    const keys = Object.keys(data)
    data = {}
    scheduleSave()
    keys.forEach((key) => broadcastChange(key, undefined, clientId))
  },
} satisfies NamespaceHandlers
