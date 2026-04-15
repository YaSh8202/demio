// ── Agent IPC Handlers ───────────────────────────────────────────────────────
//
// `sendMessage` persists the incoming user message, starts the orchestrator,
// and pipes the resulting UIMessage SSE byte stream over IPC to the renderer
// using a per-run `runId`. The renderer's custom chat fetch reassembles the
// bytes into a Response that DefaultChatTransport consumes.

import { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import {
  getMessages,
  getProject,
  appendMessage,
} from "../store"
import { runAgent } from "../agent/orchestrator"
import { startSession, cancelSession } from "../agent/sessions"
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

    const decoder = new TextDecoder()

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
          broadcast("agent:onEnd", runId)
          return
        }

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            broadcast("agent:onChunk", runId, decoder.decode(value, { stream: true }))
          }
        }
        const tail = decoder.decode()
        if (tail) broadcast("agent:onChunk", runId, tail)
        broadcast("agent:onEnd", runId)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error("[agent] run failed:", error)
        broadcast("agent:onError", runId, msg)
      }
    }

    pump()

    return { runId }
  },

  cancel: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    cancelSession(projectId, threadId)
    return { cancelled: true }
  },
} satisfies NamespaceHandlers
