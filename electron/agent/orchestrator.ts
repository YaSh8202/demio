// ── Agent Orchestrator ───────────────────────────────────────────────────────
//
// Builds a Mastra `Agent` per run (via `createDemioAgent`) and streams its
// output as an ai-sdk v6 UIMessage SSE Response. The handler pipes
// `response.body` over IPC to the renderer.
//
// Stop conditions: `stepCountIs(50)` (hard ceiling) and `hasToolCall("present_files")`
// (turn ender — `present_files` is the agent's "I'm done, show me to the user"
// signal). Mastra's `stopWhen` accepts ai-sdk v6 StopConditions directly.

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  hasToolCall,
  isToolUIPart,
  stepCountIs,
} from "ai"
import type { InferUIMessageChunk, UIMessage as AISdkUIMessage } from "ai"
import { toAISdkStream } from "@mastra/ai-sdk"
import { createDemioAgent } from "./mastra"
import { clearSession } from "./sessions"
import { ensureWorkspace } from "./workspace"
import { appendMessage, getThread, getProject } from "../store"
import { getDecryptedKey } from "../store/provider-keys"
import type { MessageMetadata } from "../store/types"
import { MessageStatus } from "../store/types"
import { isPhoenixEnabled } from "../observability/phoenix"
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

  const voiceId = project?.meta.voiceId ?? null
  const voiceName = project?.meta.voiceName ?? null
  const elevenLabsKey = voiceId ? getDecryptedKey("elevenlabs") : null
  const voiceConfigured = Boolean(voiceId && elevenLabsKey)

  const agent = createDemioAgent({
    workspace,
    signal,
    modelId,
    projectTitle: project?.project.name,
    threadTitle: thread?.title,
    domain: thread?.domain ?? null,
    voiceId,
    voiceName,
    elevenLabsKey,
  })

  log.info(
    `[agent] Starting Mastra agent with model ${modelId}` +
      (voiceConfigured ? ` (voice: ${voiceName ?? voiceId})` : "")
  )

  const mastraStream = await agent.stream(messages, {
    abortSignal: signal,
    stopWhen: [stepCountIs(50), hasToolCall("present_files")],
    // Phoenix tracing: the global NodeTracerProvider from observability/phoenix.ts
    // picks up OpenInference spans from the underlying ai-sdk model calls when
    // PHOENIX_ENABLED=true. `tracingOptions.metadata` attaches our run metadata
    // to Mastra's root span — Mastra's own observability layer is opt-in via
    // @mastra/observability and not wired up here.
    tracingOptions: isPhoenixEnabled()
      ? {
          metadata: {
            "session.id": threadId,
            "user.id": projectId,
            projectId,
            threadId,
            modelId,
            projectTitle: project?.project.name ?? "",
            threadTitle: thread?.title ?? "",
            functionId: "demio.agent.run",
            voiceConfigured: String(voiceConfigured),
            voiceId: voiceId ?? "",
            voiceName: voiceName ?? "",
          },
        }
      : undefined,
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingLevel: "high",
          includeThoughts: true,
        },
      },
      anthropic: {
        effort: "high",
        thinking: {
          type: "enabled",
        },
      },
      openai: {
        forceReasoning: true,
        reasoningEffort: "high",
      },
      bedrock: {
        reasoningConfig: { type: "enabled", budgetTokens: 4096 },
      },
    },
  })

  signal.addEventListener("abort", () => clearSession(projectId, threadId), {
    once: true,
  })

  const uiMessageStream = createUIMessageStream<AISdkUIMessage<MessageMetadata>>({
    originalMessages: messages,
    execute: async ({ writer }) => {
      const aiStream = toAISdkStream(mastraStream, {
        from: "agent",
        version: "v6",
        sendReasoning: true,
      })
      const reader = aiStream.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        // Mastra emits default-typed V6 chunks (`messageMetadata: unknown`);
        // our stream is parameterized with `MessageMetadata`. The runtime
        // shape matches — metadata is attached in `onFinish`, not via the
        // chunk stream — so cast to satisfy the writer's narrower generic.
        writer.write(
          value as InferUIMessageChunk<AISdkUIMessage<MessageMetadata>>
        )
      }
    },
    onFinish: ({ responseMessage, isAborted }) => {
      if (!responseMessage || responseMessage.role !== "assistant") return
      // If the user cancelled before the model produced anything, skip
      // persisting an empty assistant message — it would clutter the thread
      // and confuse follow-up turns.
      if (!responseMessage.parts || responseMessage.parts.length === 0) return

      // Rewrite tool parts that never reached a terminal state into
      // `output-error` so the persisted message is self-consistent — every
      // tool-call has a matching tool-result. Without this, an abort
      // mid-execution leaves an `input-available` tool part on disk and the
      // next turn's message conversion emits an orphan tool-call, throwing
      // MissingToolResultsError.
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

        // Redact secret answers from the `ask_user` tool before persistence.
        // The live stream that already reached the renderer carries the real
        // values (so the agent could act on them this turn); the on-disk
        // history must NOT. Each question in `part.input.questions[i]` carries
        // a `secret` flag — when true, replace `part.output.answers[i]` with
        // `["***"]` in a cloned output.
        if (
          part.type === "tool-ask_user" &&
          part.state === "output-available"
        ) {
          const input = part.input as
            | { questions?: Array<{ secret?: boolean }> }
            | undefined
          const output = part.output as
            | { answers?: string[][]; summary?: string; ok?: boolean }
            | undefined

          if (input?.questions && output?.answers) {
            const hasSecret = input.questions.some((q) => q?.secret === true)
            if (hasSecret) {
              const redactedAnswers = output.answers.map((ans, i) =>
                input.questions?.[i]?.secret ? ["***"] : ans
              )
              const redactedSummary = input.questions
                .map((q, i) => {
                  const a = redactedAnswers[i]
                  const text = a && a.length ? a.join(", ") : "Unanswered"
                  return `"${(q as { question?: string }).question ?? ""}"="${text}"`
                })
                .join(", ")
              return {
                ...part,
                output: {
                  ...output,
                  answers: redactedAnswers,
                  summary: `User answered: ${redactedSummary}. Continue with these answers in mind.`,
                },
              }
            }
          }
        }
        return part
      }) as typeof responseMessage.parts

      const metadata: MessageMetadata = {
        modelId,
        totalUsage: null,
        cost: null,
        status: isAborted ? MessageStatus.CANCELLED : MessageStatus.COMPLETE,
        messageTokens: 0,
      }

      appendMessage(projectId, threadId, {
        id: responseMessage.id,
        role: "assistant",
        parts: sanitizedParts,
        metadata,
      } as AISdkUIMessage<MessageMetadata>)
    },
  })

  return createUIMessageStreamResponse({
    stream: uiMessageStream,
  })
}
