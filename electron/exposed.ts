import { allHandlers } from "./handlers"
import { allEvents } from "./events"
import type { ExposedMeta } from "./constants"

/**
 * Generate metadata describing all available IPC handlers and events.
 *
 * This metadata is passed to the preload script via `additionalArguments`
 * so it can auto-generate typed wrapper functions without hardcoding
 * any handler/event names.
 *
 * Keep this lightweight — only namespace names and method names,
 * never implementations or types.
 */
export function getExposedMeta(): ExposedMeta {
  const handlersMeta = Object.entries(allHandlers).map(
    ([namespace, handlers]) =>
      [namespace, Object.keys(handlers)] as [string, string[]]
  )

  const eventsMeta = Object.entries(allEvents).map(
    ([namespace, events]) =>
      [namespace, Object.keys(events)] as [string, string[]]
  )

  return {
    handlers: handlersMeta,
    events: eventsMeta,
  }
}

// Re-export for type-level usage in the renderer type wrapper
export { allHandlers } from "./handlers"
export type { AllHandlers } from "./handlers"
export { allEvents } from "./events"
export type { AllEvents } from "./events"
