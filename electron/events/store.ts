/**
 * IPC events for the file-based project store.
 *
 * Namespace: "store"
 * Broadcasts data changes from the main process to renderer.
 *
 * These are "virtual" events — they don't subscribe to any native
 * Electron or OS events. The store handlers broadcast directly to
 * these channels when data changes. The event registrars here are
 * no-ops: they exist so the preload creates subscriber functions
 * for the renderer.
 */

import type { NamespaceEvents, EventCallback } from "../constants"

export const storeEvents = {
  /** Fired when the project list changes (create/update/delete). */
  onProjectsChanged: (_callback: EventCallback) => {
    return () => {}
  },

  /** Fired when a project's thread list changes. */
  onThreadsChanged: (_callback: EventCallback) => {
    return () => {}
  },

  /** Fired when a new message is appended to a thread. */
  onMessageAppended: (_callback: EventCallback) => {
    return () => {}
  },
} satisfies NamespaceEvents
