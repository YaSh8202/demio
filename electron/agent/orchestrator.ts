// ── Agent Orchestrator ───────────────────────────────────────────────────────
//
// Builds a ToolLoopAgent per run with:
//   - a single `terminal` tool whose cwd is the thread workspace
//   - a system prompt carrying workspace + project/thread context
//   - stepCountIs(50) to cover the full discovery → script → record → compose loop
//
// Returns an ai-sdk UIMessage SSE Response. The handler pipes response.body
// over IPC to the renderer.

import {
  ToolLoopAgent,
  stepCountIs,
  hasToolCall,
  convertToModelMessages,
} from "ai"
import type { UIMessage as AISdkUIMessage } from "ai"
import { getModel } from "./providers"
import { systemPrompt } from "./prompts"
import { createTerminalTool } from "./tools/terminal"
import { createPresentFilesTool } from "./tools/present-files"
import { createReadTool } from "./tools/read"
import { createEditTool } from "./tools/edit"
import { clearSession } from "./sessions"
import { ensureWorkspace } from "./workspace"
import { appendMessage, getThread, getProject } from "../store"
import type { MessageMetadata } from "../store/types"
import { MessageStatus } from "../store/types"
import { type GoogleLanguageModelOptions } from "@ai-sdk/google"
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic"
import type { OpenAILanguageModelChatOptions } from "@ai-sdk/openai"
import log from "../lib/logger"

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
  const workspace = ensureWorkspace(threadId)
  const project = getProject(projectId)
  const thread = getThread(projectId, threadId)

  const model = getModel(modelId)
  const terminal = createTerminalTool({ cwd: workspace, signal })
  const present_files = createPresentFilesTool({ cwd: workspace })
  const read = createReadTool({ cwd: workspace })
  const edit = createEditTool({ cwd: workspace })

  const systemPromptText = systemPrompt({
    workspace,
    projectTitle: project?.project.name,
    threadTitle: thread?.title,
    domain: thread?.domain ?? null,
  })

  log.info(
    `[agent] Starting agent with model ${modelId} and system prompt:\n${systemPromptText}`
  )

  const agent = new ToolLoopAgent({
    model,
    instructions: systemPromptText,
    tools: { terminal, present_files, read, edit },
    stopWhen: [stepCountIs(50), hasToolCall("present_files")],
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingLevel: "high",
          includeThoughts: true,
        },
      } satisfies GoogleLanguageModelOptions,
      anthropic: {
        effort: "high",
        thinking: {
          type: "enabled",
        },
      } satisfies AnthropicLanguageModelOptions,
      openai: {
        forceReasoning: true,
        reasoningEffort: "high",
      } satisfies OpenAILanguageModelChatOptions,
    },
  })

  const result = await agent.stream({
    messages: await convertToModelMessages(messages),
    abortSignal: signal,
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
