/**
 * Typed Electron API wrapper for the renderer process.
 *
 * This file provides end-to-end type safety for IPC calls.
 * Types are derived from the actual handler/event definitions in
 * `electron/` so the renderer gets autocomplete and compile-time
 * checks without any runtime dependency on Node/Electron code.
 *
 * Usage in React components:
 * ```ts
 * import { apis, events, appInfo, sharedStorage } from "@/types/electron-api"
 *
 * // Call a handler
 * const text = await apis.clipboard.readText()
 *
 * // Subscribe to an event (returns unsubscribe fn)
 * const unsub = events.ui.onMaximized((isMaximized) => { ... })
 *
 * // Shared storage
 * sharedStorage.set("theme", "dark")
 * const unsub = sharedStorage.watch("theme", (val) => { ... })
 * ```
 */

// ---------------------------------------------------------------------------
// Import handler/event types from the main process definitions.
// These are TYPE-ONLY imports — no runtime code from electron/ is pulled in.
// ---------------------------------------------------------------------------

import type { AllHandlers } from "../../electron/exposed"
import type { AllEvents } from "../../electron/exposed"

// ---------------------------------------------------------------------------
// Derive the client-facing handler type.
//
// For each handler, we strip the first `event` parameter (IpcMainInvokeEvent)
// since the renderer never passes it — the preload wrapper adds it.
// Return types are wrapped in Promise since all calls go through
// ipcRenderer.invoke().
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- conditional type inference requires `any` for the event param match
type StripEvent<T> = T extends (event: any, ...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never

/**
 * Client-safe handler types: `apis.namespace.method(...args)`.
 * The IpcMainInvokeEvent first-arg is stripped; returns are Promise-wrapped.
 */
export type ClientHandler = {
  [NS in keyof AllHandlers]: {
    [M in keyof AllHandlers[NS]]: StripEvent<AllHandlers[NS][M]>
  }
}

// ---------------------------------------------------------------------------
// Derive the client-facing event type.
//
// Each event register in the main process has signature:
//   (callback: EventCallback) => () => void
//
// The renderer sees subscriber functions:
//   (callback: (...args) => void) => () => void
// ---------------------------------------------------------------------------

type ExtractEventCallback<T> = T extends (
  callback: (...args: infer A) => void
) => () => void
  ? (callback: (...args: A) => void) => () => void
  : never

/**
 * Client-safe event types: `events.namespace.onEvent(callback)`.
 * Returns an unsubscribe function.
 */
export type ClientEvents = {
  [NS in keyof AllEvents]: {
    [E in keyof AllEvents[NS]]: ExtractEventCallback<AllEvents[NS][E]>
  }
}

// ---------------------------------------------------------------------------
// Shared Storage interface
// ---------------------------------------------------------------------------

export interface SharedStorage {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
  getAll(): Record<string, unknown>
  watch(key: string, callback: (value: unknown) => void): () => void
  clear(): void
}

// ---------------------------------------------------------------------------
// App Info interface
// ---------------------------------------------------------------------------

export interface AppInfo {
  version: string
  platform: string
  windowName: string
}

// ---------------------------------------------------------------------------
// Runtime accessors (cast from window globals)
// ---------------------------------------------------------------------------

/**
 * Type-safe IPC handler calls.
 * Returns `null` if not running in Electron.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing contextBridge globals requires untyped cast
export const apis: ClientHandler | null = (globalThis as any).__apis ?? null

/**
 * Type-safe event subscriptions.
 * Returns `null` if not running in Electron.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing contextBridge globals requires untyped cast
export const events: ClientEvents | null = (globalThis as any).__events ?? null

/**
 * Cross-window reactive shared storage.
 * Returns `null` if not running in Electron.
 */
export const sharedStorage: SharedStorage | null =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing contextBridge globals requires untyped cast
  (globalThis as any).__sharedStorage ?? null

/**
 * App metadata (version, platform, window name).
 * Returns `null` if not running in Electron.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing contextBridge globals requires untyped cast
export const appInfo: AppInfo | null = (globalThis as any).__appInfo ?? null

/**
 * Returns true if we're running inside Electron (preload injected APIs).
 */
export const isElectron = apis !== null

// ---------------------------------------------------------------------------
// Global Window augmentation
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __apis: ClientHandler
    __events: ClientEvents
    __sharedStorage: SharedStorage
    __appInfo: AppInfo
  }
}
