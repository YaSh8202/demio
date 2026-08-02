import { BrowserWindow } from "electron"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceEvents } from "../constants"
import { uiEvents } from "./ui"
import { agentBrowserEvents } from "./agent-browser"
import { storeEvents } from "./store"
import { agentEvents } from "./agent"
import { providerKeysEvents } from "./provider-keys"

/**
 * All event namespaces.
 *
 * To add a new namespace:
 * 1. Create `electron/events/my-namespace.ts` exporting a NamespaceEvents
 * 2. Import it here and add it to `allEvents`
 * 3. That's it — metadata generation & preload subscribers are automatic.
 */
export const allEvents = {
  ui: uiEvents,
  agentBrowser: agentBrowserEvents,
  store: storeEvents,
  agent: agentEvents,
  providerKeys: providerKeysEvents,
} satisfies Record<string, NamespaceEvents>

/** Type-level export for the renderer type wrapper. */
export type AllEvents = typeof allEvents

/**
 * Register all event emitters and wire them to broadcast.
 *
 * For each event registrar, we pass a callback that broadcasts
 * the event payload to every BrowserWindow via the event channel.
 *
 * Call this AFTER creating windows so the event subscriptions
 * can attach to existing BrowserWindow instances.
 */
export function registerEvents() {
  const cleanups: (() => void)[] = []

  for (const [namespace, namespaceEvents] of Object.entries(allEvents)) {
    for (const [key, eventRegister] of Object.entries(namespaceEvents)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads vary per-event
      const cleanup = eventRegister((...args: any[]) => {
        const channel = `${namespace}:${key}`

        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send(DEMIO_EVENT_CHANNEL, channel, ...args)
          }
        })
      })

      cleanups.push(cleanup)
    }
  }

  return () => cleanups.forEach((fn) => fn())
}
