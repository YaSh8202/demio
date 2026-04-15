/**
 * Preload script — the bridge between main and renderer.
 *
 * This script runs in a privileged context with access to Node/Electron
 * APIs but exposes only safe, structured interfaces to the renderer
 * via contextBridge.
 *
 * Key patterns:
 * 1. Reads handler/event metadata from `additionalArguments`
 * 2. Auto-generates namespace.method() wrappers for all handlers
 * 3. Auto-generates namespace.onEvent() subscribers for all events
 * 4. Initializes shared storage synchronously at preload time
 * 5. Exposes everything via contextBridge.exposeInMainWorld()
 */

import { contextBridge, ipcRenderer } from "electron"
import log from "electron-log/node"
// Wire up the IPC bridge so renderer logs are forwarded to the main log file
// eslint-disable-next-line @typescript-eslint/no-require-imports
const initElectronLog = require("electron-log/preload") as (opts: {
  contextBridge: Electron.ContextBridge
  ipcRenderer: Electron.IpcRenderer
}) => void
initElectronLog({ contextBridge, ipcRenderer })

// Channel names — must match constants.ts
// We inline these instead of importing to keep the preload bundle small
// and avoid pulling in any Electron main-process code.
const DEMIO_API_CHANNEL = "demio-ipc-api"
const DEMIO_EVENT_CHANNEL = "demio-ipc-event"

// ---------------------------------------------------------------------------
// Types (mirrored from constants.ts to avoid cross-process import)
// ---------------------------------------------------------------------------

interface ExposedMeta {
  handlers: [namespace: string, methods: string[]][]
  events: [namespace: string, eventNames: string[]][]
}

interface AppInfo {
  version: string
  platform: NodeJS.Platform
  windowName: string
}

// ---------------------------------------------------------------------------
// Parse metadata from additionalArguments
// ---------------------------------------------------------------------------

function parseMeta(): ExposedMeta {
  const arg = process.argv.find((a) => a.startsWith("--main-exposed-meta="))
  if (!arg) {
    log.warn("[preload] No --main-exposed-meta found in argv")
    return { handlers: [], events: [] }
  }
  try {
    return JSON.parse(arg.slice("--main-exposed-meta=".length))
  } catch (e) {
    log.error("[preload] Failed to parse exposed meta:", e)
    return { handlers: [], events: [] }
  }
}

function parseWindowName(): string {
  const arg = process.argv.find((a) => a.startsWith("--window-name="))
  return arg ? arg.slice("--window-name=".length) : "main"
}

// ---------------------------------------------------------------------------
// Auto-generate handler wrappers (apis)
// ---------------------------------------------------------------------------

function buildApis(meta: ExposedMeta) {
  return Object.fromEntries(
    meta.handlers.map(([namespace, methods]) => [
      namespace,
      Object.fromEntries(
        methods.map((method) => [
          method,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC boundary: args are type-erased at runtime
          (...args: any[]) =>
            ipcRenderer.invoke(
              DEMIO_API_CHANNEL,
              `${namespace}:${method}`,
              ...args
            ),
        ])
      ),
    ])
  )
}

// ---------------------------------------------------------------------------
// Auto-generate event subscribers (events)
// ---------------------------------------------------------------------------

function buildEvents(meta: ExposedMeta) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC boundary: listener signatures vary per-event
  const listenersMap = new Map<string, ((...args: any[]) => void)[]>()

  // Single listener for all events — dispatches to registered callbacks
  ipcRenderer.on(
    DEMIO_EVENT_CHANNEL,
    (
      _event: Electron.IpcRendererEvent,
      channel: string,
      ...args: unknown[]
    ) => {
      const listeners = listenersMap.get(channel)
      if (listeners) {
        listeners.forEach((listener) => listener(...args))
      }
    }
  )

  return Object.fromEntries(
    meta.events.map(([namespace, eventNames]) => [
      namespace,
      Object.fromEntries(
        eventNames.map((name) => {
          const channel = `${namespace}:${name}`
          return [
            name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC boundary: callback signatures vary per-event
            (callback: (...args: any[]) => void) => {
              const existing = listenersMap.get(channel) ?? []
              listenersMap.set(channel, [...existing, callback])

              // Return unsubscribe function
              return () => {
                const listeners = listenersMap.get(channel) ?? []
                const index = listeners.indexOf(callback)
                if (index !== -1) {
                  listeners.splice(index, 1)
                }
              }
            },
          ]
        })
      ),
    ])
  )
}

// ---------------------------------------------------------------------------
// Shared Storage client
// ---------------------------------------------------------------------------

function buildSharedStorage() {
  // Unique client ID to ignore self-originated broadcasts
  const CLIENT_ID = Math.random().toString(36).slice(2)

  // In-memory mirror, initialized synchronously
  const memory = new Map<string, unknown>()

  // Watchers: key → Set of callbacks
  const watchers = new Map<string, Set<(value: unknown) => void>>()

  // Load initial state synchronously at preload time
  const initialState = ipcRenderer.sendSync(
    DEMIO_API_CHANNEL,
    "sharedStorage:getAllGlobalState"
  )
  if (initialState && typeof initialState === "object") {
    for (const [key, value] of Object.entries(initialState)) {
      memory.set(key, value)
    }
  }

  // Listen for changes broadcast from other windows
  ipcRenderer.on(
    DEMIO_EVENT_CHANNEL,
    (
      _event: Electron.IpcRendererEvent,
      channel: string,
      updates: Record<string, { v: unknown; s: string }>
    ) => {
      if (channel === "sharedStorage:onGlobalStateChanged") {
        for (const [key, raw] of Object.entries(updates)) {
          // Ignore broadcasts from this client
          if (raw.s !== CLIENT_ID) {
            memory.set(key, raw.v)
            // Notify watchers
            const keyWatchers = watchers.get(key)
            if (keyWatchers) {
              keyWatchers.forEach((cb) => cb(raw.v))
            }
          }
        }
      }
    }
  )

  return {
    /** Get a value by key. */
    get(key: string): unknown {
      return memory.get(key) ?? null
    },

    /** Set a value. Persists to main and broadcasts to other windows. */
    set(key: string, value: unknown): void {
      memory.set(key, value)
      // Notify local watchers immediately
      const keyWatchers = watchers.get(key)
      if (keyWatchers) {
        keyWatchers.forEach((cb) => cb(value))
      }
      // Async persist + broadcast
      ipcRenderer.invoke(
        DEMIO_API_CHANNEL,
        "sharedStorage:setGlobalState",
        key,
        value,
        CLIENT_ID
      )
    },

    /** Delete a key. */
    delete(key: string): void {
      memory.delete(key)
      const keyWatchers = watchers.get(key)
      if (keyWatchers) {
        keyWatchers.forEach((cb) => cb(undefined))
      }
      ipcRenderer.invoke(
        DEMIO_API_CHANNEL,
        "sharedStorage:deleteGlobalState",
        key,
        CLIENT_ID
      )
    },

    /** Get all keys and values. */
    getAll(): Record<string, unknown> {
      return Object.fromEntries(memory)
    },

    /**
     * Watch a key for changes. Returns an unsubscribe function.
     * Fires immediately with current value, then on every change.
     */
    watch(key: string, callback: (value: unknown) => void): () => void {
      if (!watchers.has(key)) {
        watchers.set(key, new Set())
      }
      watchers.get(key)!.add(callback)

      // Fire immediately with current value
      callback(memory.get(key) ?? null)

      return () => {
        const keyWatchers = watchers.get(key)
        if (keyWatchers) {
          keyWatchers.delete(callback)
          if (keyWatchers.size === 0) {
            watchers.delete(key)
          }
        }
      }
    },

    /** Clear all shared state. */
    clear(): void {
      const keys = [...memory.keys()]
      memory.clear()
      // Notify all watchers
      keys.forEach((key) => {
        const keyWatchers = watchers.get(key)
        if (keyWatchers) {
          keyWatchers.forEach((cb) => cb(undefined))
        }
      })
      ipcRenderer.invoke(
        DEMIO_API_CHANNEL,
        "sharedStorage:clearGlobalState",
        CLIENT_ID
      )
    },
  }
}

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------

function buildAppInfo(): AppInfo {
  return {
    version: process.argv.find((a) => a.startsWith("--app-version="))
      ? process.argv
          .find((a) => a.startsWith("--app-version="))!
          .slice("--app-version=".length)
      : "0.0.0",
    platform: process.platform,
    windowName: parseWindowName(),
  }
}

// ---------------------------------------------------------------------------
// Bootstrap — expose everything to the renderer
// ---------------------------------------------------------------------------

const meta = parseMeta()

const apis = buildApis(meta)
const events = buildEvents(meta)
const sharedStorage = buildSharedStorage()
const appInfo = buildAppInfo()

contextBridge.exposeInMainWorld("__apis", apis)
contextBridge.exposeInMainWorld("__events", events)
contextBridge.exposeInMainWorld("__sharedStorage", sharedStorage)
contextBridge.exposeInMainWorld("__appInfo", appInfo)
