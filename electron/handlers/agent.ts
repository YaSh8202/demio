// ── Agent IPC Handlers ───────────────────────────────────────────────────────
//
// Controller-backed surface. Every AgentController event for a session is
// broadcast as `agent:onEvent` keyed by `${projectId}:${threadId}`; the
// renderer rebuilds message + progress state from events and can re-hydrate
// after refresh via `getDisplayState`.
//
// The session logic itself lives in `agent/session-driver.ts`, which has no
// `electron` import so the headless smoke runner can drive a session through
// the same code. This file only adapts it to IPC: strip the invoke event,
// and fan the driver's events out to every window.

import { BrowserWindow } from "electron"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import * as driver from "../agent/session-driver"
import type { UIMessage } from "../store/types"

function broadcast(channel: string, ...args: unknown[]) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(DEMIO_EVENT_CHANNEL, channel, ...args)
    }
  })
}

driver.addSessionEventSink((key, event) =>
  broadcast("agent:onEvent", key, event)
)

function extractText(message: UIMessage): string {
  return (message.parts ?? [])
    .map((p) => (p.type === "text" ? (p as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n")
}

export const agentHandlers = {
  sendMessage: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    body: { message: UIMessage; modelId?: string }
  ) =>
    driver.sendMessage(projectId, threadId, {
      text: extractText(body.message),
      modelId: body.modelId,
    }),

  respondSuspension: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    body: { toolCallId: string; resumeData: unknown }
  ) => driver.respondSuspension(projectId, threadId, body),

  cancel: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => driver.cancel(projectId, threadId),

  getDisplayState: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => driver.getDisplayState(projectId, threadId),

  // History for thread mount / refresh-reattach. Controller storage is the
  // source of truth for controller-era conversations (ADR-007 amended).
  listMessages: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    limit?: number
  ) => driver.listMessages(projectId, threadId, limit),
} satisfies NamespaceHandlers
