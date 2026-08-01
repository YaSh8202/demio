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
import type {
  InferUIMessageChunk,
  LanguageModelUsage,
  UIMessage as AISdkUIMessage,
} from "ai"
import { toAISdkStream } from "@mastra/ai-sdk"
import { createDemioAgent } from "./mastra"
import { buildLiveUsageMetadata, buildUsageMetadata } from "./usage"
import { clearSession } from "./sessions"
import { ensureWorkspace } from "./workspace"
import { appendMessage, getThread, getProject } from "../store"
import { getDecryptedKey } from "../store/provider-keys"
import type { MessageMetadata } from "../store/types"
import { MessageStatus } from "../store/types"
import { isPhoenixEnabled } from "../observability/phoenix"
import log from "../lib/logger"

// How many extra `agent.stream()` attempts to make when the upstream transport
// dies before a single chunk has reached the writer. Mastra's own `pRetry` only
// wraps the `doStream()` *connect* — once the SSE body is open, a reset (undici
// `TypeError: terminated` / `ECONNRESET`) is unrecoverable at its layer. Retrying
// is only safe while nothing has been written, since emitted chunks cannot be
// retracted from the UI stream.
const MAX_TRANSPORT_RETRIES = 2

/** How long `onFinish` will wait on the run's usage totals before giving up. */
const USAGE_TIMEOUT_MS = 5_000

/**
 * True for connection-level failures that are worth re-issuing the request for
 * (reset sockets, aborted bodies), as opposed to model/validation errors where
 * a retry would just fail the same way.
 */
function isTransportError(err: unknown): boolean {
  if (!err) return false

  // ai-sdk marks upstream call errors it considers safe to retry.
  if (
    typeof err === "object" &&
    "isRetryable" in err &&
    (err as { isRetryable?: unknown }).isRetryable === true
  ) {
    return true
  }

  const parts: string[] = []
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth++) {
    if (typeof cur === "string") {
      parts.push(cur)
      break
    }
    if (typeof cur !== "object") break
    const asErr = cur as { message?: unknown; code?: unknown; cause?: unknown }
    if (typeof asErr.message === "string") parts.push(asErr.message)
    if (typeof asErr.code === "string") parts.push(asErr.code)
    cur = asErr.cause
  }

  const text = parts.join(" ")
  return (
    text.includes("ECONNRESET") ||
    text.includes("ECONNREFUSED") ||
    text.includes("ETIMEDOUT") ||
    text.includes("EPIPE") ||
    text.includes("terminated") ||
    text.includes("fetch failed") ||
    text.includes("socket hang up")
  )
}

/**
 * Structural chunks a stream emits before the model has produced anything.
 *
 * They carry no content, so holding them back costs nothing visually and buys
 * a retry window for a connection that dies during the preamble.
 */
function isPreambleChunk(chunk: { type?: string }): boolean {
  return chunk?.type === "start" || chunk?.type === "start-step"
}

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

  const startStream = () =>
    agent.stream(messages, {
      abortSignal: signal,
      // Cast: Mastra's `stopWhen` still vendors ai-sdk v5/v6-shaped
      // `StopCondition` snapshots (see `@mastra/core/dist/loop/types.d.ts`),
      // not yet updated for ai v7's `StopCondition<TOOLS, RUNTIME_CONTEXT>`.
      // Both are the same runtime shape — `(options: { steps }) => boolean`
      // — so this is a type-only mismatch.
      stopWhen: [stepCountIs(50), hasToolCall("present_files")] as never,
      // Mastra pulls `maxRetries` off `modelSettings` and feeds it to `pRetry` as
      // `retries` around the `doStream()` call, so 4 => 5 connect attempts. It
      // only covers establishing the stream; the mid-flight case is handled by
      // the retry loop in `execute` below.
      modelSettings: { maxRetries: 4 },
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

  // Kick off the first attempt eagerly so setup failures (missing API key,
  // unsupported provider) still reject out of `runAgent` and reach the IPC
  // handler's catch, rather than being swallowed into the UI stream.
  const firstStream = await startStream()

  // Tracks whichever attempt actually produced the output, so `onFinish` can
  // read usage off the right stream — a transport retry replaces this reference
  // and the discarded attempt's usage would be empty.
  let finalStream = firstStream

  signal.addEventListener("abort", () => clearSession(projectId, threadId), {
    once: true,
  })

  const uiMessageStream = createUIMessageStream<
    AISdkUIMessage<MessageMetadata>
  >({
    originalMessages: messages,
    execute: async ({ writer }) => {
      // Every stream opens with structural chunks (`start`, `start-step`)
      // before the model says anything. Those are held back rather than
      // forwarded, so a connection that dies during the preamble — run 1's
      // failure mode — can still be retried with nothing yet on screen. Once
      // real content arrives the buffer is flushed and retrying is off the
      // table, since emitted chunks cannot be retracted from the renderer.
      let committed = false

      for (let attempt = 0; ; attempt++) {
        const aiStream = toAISdkStream(finalStream, {
          from: "agent",
          version: "v6",
          sendReasoning: true,
          // Attach usage + cost to the `finish` chunk so the renderer can show
          // them as the run lands. Mastra has already normalized `totalUsage`
          // to ai-sdk v6's nested shape by this point. `onFinish` recomputes
          // the same numbers for persistence — this copy is for the live UI.
          //
          // Cast: Mastra's vendored v6 types leave message metadata as
          // `unknown`, the same mismatch documented at the chunk cast below.
          messageMetadata: (({ part }: { part: { type?: string } }) =>
            part?.type === "finish"
              ? buildLiveUsageMetadata(
                  modelId,
                  (part as { totalUsage?: LanguageModelUsage }).totalUsage
                )
              : undefined) as never,
        })
        const reader = aiStream.getReader()
        let preamble: InferUIMessageChunk<AISdkUIMessage<MessageMetadata>>[] =
          []

        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) return

            // Mastra reports a failed `createStream` in-band as an error chunk
            // instead of rejecting, so treat that identically to a throw.
            if (!committed && (value as { type?: string })?.type === "error") {
              throw (
                (value as { error?: unknown }).error ??
                new Error("stream error")
              )
            }

            // Mastra emits default-typed V6 chunks (`messageMetadata: unknown`);
            // our stream is parameterized with `MessageMetadata`. The runtime
            // shape matches — metadata is attached in `onFinish`, not via the
            // chunk stream — so cast to satisfy the writer's narrower generic.
            const chunk = value as InferUIMessageChunk<
              AISdkUIMessage<MessageMetadata>
            >

            if (committed) {
              writer.write(chunk)
              continue
            }

            if (isPreambleChunk(chunk)) {
              preamble.push(chunk)
              continue
            }

            // First real content — flush the held preamble in order, then
            // switch to pass-through for the rest of the run.
            committed = true
            for (const held of preamble) writer.write(held)
            preamble = []
            writer.write(chunk)
          }
        } catch (err) {
          const canRetry =
            !committed &&
            !signal.aborted &&
            attempt < MAX_TRANSPORT_RETRIES &&
            isTransportError(err)

          if (!canRetry) {
            // Nothing was forwarded yet, so replay the preamble to keep the UI
            // stream well-formed before the error propagates.
            for (const held of preamble) writer.write(held)
            throw err
          }

          log.warn(
            `[agent] transport error before any output (attempt ${
              attempt + 1
            }/${MAX_TRANSPORT_RETRIES + 1}), re-issuing request:`,
            err
          )
          finalStream = await startStream()
        } finally {
          reader.releaseLock()
        }
      }
    },
    onFinish: async ({ responseMessage, isAborted }) => {
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
        // A stream that dies mid-thought leaves its reasoning part at
        // `state: "streaming"`. Persisting that makes the reloaded thread
        // render a permanent "Thinking..." shimmer, so force it terminal.
        if (part.type === "reasoning" && part.state === "streaming") {
          return { ...part, state: "done" as const }
        }

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

      // `totalUsage` resolves once the stream is fully consumed, which it is by
      // the time `onFinish` runs — an aborted run included, reporting whatever
      // was billed before the cancel.
      //
      // Raced against a deadline regardless: persisting the message matters far
      // more than costing it, and an unsettled promise here would strand the
      // whole assistant turn instead of just its usage numbers.
      const usage = await Promise.race([
        finalStream.totalUsage.catch((err: unknown) => {
          log.warn("[agent] could not read usage for finished run:", err)
          return undefined
        }),
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => {
            log.warn("[agent] timed out reading usage for finished run")
            resolve(undefined)
          }, USAGE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])

      const metadata: MessageMetadata = {
        modelId,
        status: isAborted ? MessageStatus.CANCELLED : MessageStatus.COMPLETE,
        ...(await buildUsageMetadata(modelId, usage)),
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
