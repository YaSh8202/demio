// ── IPC Chat Transport ───────────────────────────────────────────────────────
//
// Custom fetch compatible with ai-sdk's DefaultChatTransport. Instead of
// issuing a network request it invokes `apis.agent.sendMessage` in the main
// process, then assembles a Response whose body is a ReadableStream fed by
// `events.agent.onChunk`. This lets `useChat` consume the ai-sdk UIMessage
// SSE stream the exact same way as over HTTP.

import { apis, events } from "@/types/electron-api"

export function createIpcChatFetch(projectId: string, threadIdRef: {
  current: string | null
}) {
  return async function ipcChatFetch(
    _url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    if (!apis || !events) {
      throw new Error("Electron IPC not available")
    }

    const threadId = threadIdRef.current
    if (!threadId) {
      throw new Error("No active thread")
    }

    const body = init?.body ? JSON.parse(init.body as string) : {}

    const { runId } = await apis.agent.sendMessage(projectId, threadId, body)

    let unsubChunk: (() => void) | null = null
    let unsubEnd: (() => void) | null = null
    let unsubError: (() => void) | null = null

    const cleanup = () => {
      unsubChunk?.()
      unsubEnd?.()
      unsubError?.()
    }

    const encoder = new TextEncoder()

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        unsubChunk = events!.agent.onChunk(
          (evtRunId: string, chunk: string) => {
            if (evtRunId !== runId) return
            controller.enqueue(encoder.encode(chunk))
          }
        )
        unsubEnd = events!.agent.onEnd((evtRunId: string) => {
          if (evtRunId !== runId) return
          cleanup()
          controller.close()
        })
        unsubError = events!.agent.onError(
          (evtRunId: string, message: string) => {
            if (evtRunId !== runId) return
            cleanup()
            controller.error(new Error(message))
          }
        )

        if (init?.signal) {
          if (init.signal.aborted) {
            cleanup()
            controller.error(new DOMException("Aborted", "AbortError"))
            return
          }
          init.signal.addEventListener(
            "abort",
            () => {
              apis!.agent.cancel(projectId, threadId)
              cleanup()
              try {
                controller.error(new DOMException("Aborted", "AbortError"))
              } catch {
                // already closed
              }
            },
            { once: true }
          )
        }
      },
      cancel() {
        cleanup()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    })
  }
}
