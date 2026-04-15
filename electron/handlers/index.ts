import { ipcMain } from "electron"
import { DEMIO_API_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import { uiHandlers } from "./ui"
import { clipboardHandlers } from "./clipboard"
import { sharedStorageHandlers } from "../shared-storage"
import { agentBrowserHandlers } from "./agent-browser"
import { streamHandlers } from "./stream"
import { storeHandlers } from "./store"
import { agentHandlers } from "./agent"
import { providerKeysHandlers } from "./provider-keys"

/**
 * All handler namespaces.
 *
 * To add a new namespace:
 * 1. Create `electron/handlers/my-namespace.ts` exporting a NamespaceHandlers
 * 2. Import it here and add it to `allHandlers`
 * 3. That's it — metadata generation & preload wrappers are automatic.
 */
export const allHandlers = {
  ui: uiHandlers,
  clipboard: clipboardHandlers,
  sharedStorage: sharedStorageHandlers,
  agentBrowser: agentBrowserHandlers,
  stream: streamHandlers,
  store: storeHandlers,
  agent: agentHandlers,
  providerKeys: providerKeysHandlers,
} satisfies Record<string, NamespaceHandlers>

/** Type-level export for the renderer type wrapper. */
export type AllHandlers = typeof allHandlers

/**
 * Register the single-channel IPC handler that routes all calls.
 *
 * Uses `namespace:method` string as the first arg to route to the
 * correct handler function. Wraps in try/catch with timing logs.
 */
export function registerHandlers() {
  // Async handler (ipcRenderer.invoke)
  ipcMain.handle(DEMIO_API_CHANNEL, async (event, ...args) => {
    const channel = args[0] as string
    const [namespace, method] = channel.split(":")

    if (!namespace || !method) {
      console.error(`[IPC] Invalid channel: ${channel}`)
      return null
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic namespace lookup requires Record<string, any>
    const handler = (allHandlers as Record<string, Record<string, any>>)[
      namespace
    ]?.[method]
    if (!handler) {
      console.error(`[IPC] Handler not found: ${channel}`)
      return null
    }

    const handlerArgs = args.slice(1)
    const start = Date.now()

    try {
      const result = await handler(event, ...handlerArgs)
      if (process.env.NODE_ENV === "development") {
        console.log(`[IPC] ${channel} — ${Date.now() - start}ms`)
      }
      return result
    } catch (error) {
      console.error(`[IPC] Error in ${channel}:`, error)
      throw error
    }
  })

  // Sync handler (ipcRenderer.sendSync) — used for shared storage init
  ipcMain.on(DEMIO_API_CHANNEL, (event, ...args) => {
    const channel = args[0] as string
    const [namespace, method] = channel.split(":")

    if (!namespace || !method) {
      event.returnValue = null
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic namespace lookup requires Record<string, any>
    const handler = (allHandlers as Record<string, Record<string, any>>)[
      namespace
    ]?.[method]
    if (!handler) {
      event.returnValue = null
      return
    }

    const handlerArgs = args.slice(1)
    try {
      // Sync handlers must return synchronously
      event.returnValue = handler(event, ...handlerArgs)
    } catch (error) {
      console.error(`[IPC:sync] Error in ${channel}:`, error)
      event.returnValue = null
    }
  })
}
