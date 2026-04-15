// ── Agent Orchestrator ───────────────────────────────────────────────────────
//
// Runs streamText and returns the ai-sdk UIMessage SSE Response. Caller pipes
// response.body bytes over IPC to the renderer.

import { streamText, convertToModelMessages, stepCountIs } from "ai"
import type { UIMessage as AISdkUIMessage } from "ai"
import { getModel } from "./providers"
import { systemPrompt } from "./prompts"
import { runBrowser } from "./tools/run-browser"
import { clearSession } from "./sessions"
import { appendMessage } from "../store"
import type { MessageMetadata } from "../store/types"
import { MessageStatus } from "../store/types"

export interface RunAgentOptions {
  projectId: string
  threadId: string
  messages: AISdkUIMessage<MessageMetadata>[]
  modelId: string
  signal: AbortSignal
}

export async function runAgent({
  projectId,
  threadId,
  messages,
  modelId,
  signal,
}: RunAgentOptions): Promise<Response> {
  const model = getModel(modelId)
  const modelMessages = await convertToModelMessages(messages)

  const result = streamText({
    model,
    system: systemPrompt(),
    messages: modelMessages,
    tools: { runBrowser },
    stopWhen: stepCountIs(10),
    abortSignal: signal,
    onError: ({ error }) => {
      console.error("[agent] streamText error:", error)
    },
  })

  signal.addEventListener("abort", () => clearSession(projectId, threadId), {
    once: true,
  })

  return result.toUIMessageStreamResponse<AISdkUIMessage<MessageMetadata>>({
    sendReasoning: true,
    onFinish: ({ responseMessage, isAborted }) => {
      if (isAborted || !responseMessage || responseMessage.role !== "assistant")
        return

      const metadata: MessageMetadata = {
        modelId,
        totalUsage: null,
        cost: null,
        status: MessageStatus.COMPLETE,
        messageTokens: 0,
      }

      appendMessage(projectId, threadId, {
        id: responseMessage.id,
        role: "assistant",
        parts: responseMessage.parts,
        metadata,
      } as AISdkUIMessage<MessageMetadata>)
    },
  })
}
