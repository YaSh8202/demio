/**
 * Shared constants and types for the Demio IPC architecture.
 *
 * Single-channel RPC-style IPC with namespaced routing.
 * Main ↔ Renderer communication goes through two channels:
 *   - DEMIO_API_CHANNEL  — handler invocations (invoke/handle)
 *   - DEMIO_EVENT_CHANNEL — event broadcasts (send/on)
 */

/** Channel used for all handler invocations (namespace:method routing). */
export const DEMIO_API_CHANNEL = "demio-ipc-api"

/** Channel used for all event broadcasts from main → renderer. */
export const DEMIO_EVENT_CHANNEL = "demio-ipc-event"

/**
 * Metadata describing which handler namespaces/methods and event
 * namespaces/names are available. Passed from main → preload via
 * `additionalArguments` so the preload can auto-generate wrappers.
 */
export interface ExposedMeta {
  handlers: [namespace: string, methods: string[]][]
  events: [namespace: string, eventNames: string[]][]
}

/**
 * A handler function registered in the main process.
 * First arg is always the IpcMainInvokeEvent, rest are caller-supplied.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- IPC boundary: args/returns are type-erased at the routing layer */
export type IsomorphicHandler = (
  event: Electron.IpcMainInvokeEvent,
  ...args: any[]
) => Promise<any> | any
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A record of method-name → handler within a single namespace. */
export type NamespaceHandlers = Record<string, IsomorphicHandler>

/** Callback shape used when registering event emitters. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads vary per-event
export type EventCallback = (...args: any[]) => void

/**
 * An event registrar: accepts a broadcast callback and returns
 * an unsubscribe function (cleanup).
 */
export type EventRegister = (callback: EventCallback) => () => void

/** A record of event-name → registrar within a single namespace. */
export type NamespaceEvents = Record<string, EventRegister>
