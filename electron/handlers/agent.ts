// ── Agent IPC Handlers ───────────────────────────────────────────────────────
//
// `sendMessage` persists the incoming user message, starts the orchestrator,
// and pipes the resulting UIMessage SSE byte stream over IPC to the renderer
// using a per-run `runId`. The renderer's custom chat fetch reassembles the
// bytes into a Response that DefaultChatTransport consumes.

import { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import log from "../lib/logger"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import {
  getMessages,
  getProject,
  appendMessage,
} from "../store"
import { runAgent } from "../agent/orchestrator"
import { startSession, cancelSession } from "../agent/sessions"
import {
  appendChunk,
  clearRun,
  endRun,
  errorRun,
  getActiveRunSnapshot,
  runKey,
  startRun,
} from "../agent/runs"
import { DEFAULT_MODEL_ID } from "../agent/types"
import type { UIMessage, MessageMetadata } from "../store/types"
import { MessageStatus } from "../store/types"

function broadcast(channel: string, ...args: unknown[]) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(DEMIO_EVENT_CHANNEL, channel, ...args)
    }
  })
}

interface SendMessageBody {
  message: UIMessage
  modelId?: string
}

export const agentHandlers = {
  /**
   * Persist the user message, start the agent, and stream UIMessage SSE
   * bytes back over `agent:onChunk` keyed by the returned `runId`.
   */
  sendMessage: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    body: SendMessageBody
  ) => {
    const runId = randomUUID()

    const userMessage: UIMessage = {
      ...body.message,
      metadata: {
        modelId: null,
        totalUsage: null,
        cost: null,
        status: MessageStatus.COMPLETE,
        messageTokens: 0,
        ...(body.message.metadata as Partial<MessageMetadata> | undefined),
      },
    }
    appendMessage(projectId, threadId, userMessage)

    const projectData = getProject(projectId)
    const modelId =
      body.modelId || projectData?.meta?.selectedModel || DEFAULT_MODEL_ID

    const signal = startSession(projectId, threadId)
    const messages = getMessages(projectId, threadId)

    // Buffer this run in main so a refreshed renderer can reattach via
    // `agent.reconnect`. Replaces any prior buffered entry for this thread.
    const key = runKey(projectId, threadId)
    clearRun(key)
    startRun(key, runId)

    const decoder = new TextDecoder()

    const emitChunk = (decoded: string) => {
      const seq = appendChunk(key, runId, decoded)
      broadcast("agent:onChunk", runId, decoded, seq)
    }

    const pump = async () => {
      try {
        const response = await runAgent({
          projectId,
          threadId,
          messages,
          modelId,
          signal,
        })

        const reader = response.body?.getReader()
        if (!reader) {
          endRun(key, runId)
          broadcast("agent:onEnd", runId)
          return
        }

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            emitChunk(decoder.decode(value, { stream: true }))
          }
        }
        const tail = decoder.decode()
        if (tail) emitChunk(tail)
        endRun(key, runId)
        broadcast("agent:onEnd", runId)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error("[agent] run failed:", error)
        errorRun(key, runId, msg)
        broadcast("agent:onError", runId, msg)
      }
    }

    pump()

    return { runId }
  },

  /**
   * Return a snapshot of the in-flight (or recently-finished) run for this
   * thread, or null if there is none. The renderer uses this on mount to
   * resume an interrupted stream after a refresh.
   */
  reconnect: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    return getActiveRunSnapshot(runKey(projectId, threadId))
  },

  cancel: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    cancelSession(projectId, threadId)
    // Drop the buffered run so a refresh after cancel doesn't replay
    // partial content from a deliberately stopped stream. The pump's
    // own errorRun call no-ops because the entry is already gone.
    clearRun(runKey(projectId, threadId))
    return { cancelled: true }
  },
} satisfies NamespaceHandlers
