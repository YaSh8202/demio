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
  isToolUIPart,
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
import type { AmazonBedrockLanguageModelOptions } from "@ai-sdk/amazon-bedrock"
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
      bedrock: {
        reasoningConfig: { type: "enabled", budgetTokens: 4096 },
      } satisfies AmazonBedrockLanguageModelOptions,
    },
  })

  const result = await agent.stream({
    messages: await convertToModelMessages(messages, {
      ignoreIncompleteToolCalls: true,
    }),
    abortSignal: signal,
  })

  signal.addEventListener("abort", () => clearSession(projectId, threadId), {
    once: true,
  })

  return result.toUIMessageStreamResponse<AISdkUIMessage<MessageMetadata>>({
    sendReasoning: true,
    onFinish: ({ responseMessage, isAborted }) => {
      if (!responseMessage || responseMessage.role !== "assistant") return
      // If the user cancelled before the model produced anything, skip
      // persisting an empty assistant message — it would clutter the thread
      // and confuse follow-up turns.
      if (!responseMessage.parts || responseMessage.parts.length === 0) return

      const metadata: MessageMetadata = {
        modelId,
        totalUsage: null,
        cost: null,
        status: isAborted ? MessageStatus.CANCELLED : MessageStatus.COMPLETE,
        messageTokens: 0,
      }

      // Rewrite tool parts that never reached a terminal state into
      // `output-error` so the persisted message is self-consistent — every
      // tool-call has a matching tool-result. Without this, an abort
      // mid-execution leaves an `input-available` tool part on disk and the
      // next turn's convertToModelMessages emits an orphan tool-call,
      // throwing MissingToolResultsError.
      const sanitizedParts = responseMessage.parts.map((part) => {
        if (!isToolUIPart(part)) return part
        if (
          part.state === "input-streaming" ||
          part.state === "input-available" ||
          part.state === "approval-requested"
        ) {
          return {
            ...part,
            state: "output-error",
            errorText: "Stopped by user",
          }
        }
        return part
      }) as typeof responseMessage.parts

      appendMessage(projectId, threadId, {
        id: responseMessage.id,
        role: "assistant",
        parts: sanitizedParts,
        metadata,
      } as AISdkUIMessage<MessageMetadata>)
    },
  })
}
