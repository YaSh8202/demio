// ── IPC Chat Transport ───────────────────────────────────────────────────────
//
// Custom fetch compatible with ai-sdk's DefaultChatTransport.
//
// Two paths, distinguished by HTTP method:
//
//   POST  → send a new message. Calls `apis.agent.sendMessage`, returns a
//           Response whose body is fed by live `events.agent.onChunk`.
//
//   GET   → reconnect to an in-flight (or just-finished) run. Issued by
//           `useChat({ resume: true })` on mount. Calls `apis.agent.reconnect`
//           for the buffered snapshot, replays it, then subscribes to live
//           chunks for the remainder. Returns 204 if no active run.
//
// The renderer's AbortSignal is intentionally NOT propagated to the main
// process. `useChat` aborts the request on component unmount/refresh, but
// the main-process agent must keep running so we can resume after reload.
// Explicit user cancel goes through `apis.agent.cancel` directly from the
// cancel button (see `useActiveThread.cancelRun`).

import { apis, events } from "@/types/electron-api"

interface ReconnectSnapshot {
  runId: string
  chunks: string[]
  seq: number
  state: "running" | "ended" | "errored"
  error: string | null
  truncated: boolean
}

export function createIpcChatFetch(
  projectId: string,
  threadIdRef: { current: string | null }
) {
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

    if (init?.method === "GET") {
      return handleReconnect(projectId, threadId)
    }

    return handleSend(projectId, threadId, init)
  }
}

async function handleSend(
  projectId: string,
  threadId: string,
  init: RequestInit | undefined
): Promise<Response> {
  const body = init?.body ? JSON.parse(init.body as string) : {}
  // TODO(task-6): the controller-backed `agent.sendMessage` now returns
  // `{ ok: true }`, not `{ runId }` — progress arrives via
  // `events.agent.onEvent`, not per-run SSE chunks keyed by runId. This
  // whole chunk-replay transport is dead until Task 6 rewires the renderer
  // onto the controller event stream; a local id keeps this path
  // type-checking (and harmlessly non-functional) in the meantime.
  await apis!.agent.sendMessage(projectId, threadId, body)
  const runId = crypto.randomUUID()

  return buildLiveResponse(runId, init?.signal)
}

async function handleReconnect(
  projectId: string,
  threadId: string
): Promise<Response> {
  const snap = (await apis!.agent.reconnect(
    projectId,
    threadId
  )) as ReconnectSnapshot | null

  // For non-running snapshots (ended, errored, or cancelled), the
  // orchestrator's onFinish has already persisted the final/partial
  // assistant message to disk. The thread loader picks it up; replaying
  // the buffer here would just duplicate work and risk surfacing a
  // spurious error state for runs the user explicitly cancelled.
  if (!snap || snap.state !== "running") {
    return new Response(null, { status: 204 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastSeq = snap.seq - 1
      let closed = false

      const safeClose = () => {
        if (closed) return
        closed = true
        cleanup()
        try {
          controller.close()
        } catch {
          // already closed
        }
      }

      const safeError = (err: unknown) => {
        if (closed) return
        closed = true
        cleanup()
        try {
          controller.error(err)
        } catch {
          // already closed
        }
      }

      let unsubChunk: (() => void) | null = null
      let unsubEnd: (() => void) | null = null
      let unsubError: (() => void) | null = null

      const cleanup = () => {
        unsubChunk?.()
        unsubEnd?.()
        unsubError?.()
      }

      // Subscribe BEFORE replaying the snapshot so any chunk landing
      // between the snapshot fetch and live subscription is captured.
      // We dedupe by seq.
      if (snap.state === "running") {
        unsubChunk = events!.agent.onChunk(
          (evtRunId: string, chunk: string, seq?: number) => {
            if (evtRunId !== snap.runId) return
            if (typeof seq === "number" && seq <= lastSeq) return
            controller.enqueue(encoder.encode(chunk))
            if (typeof seq === "number") lastSeq = seq
          }
        )
        unsubEnd = events!.agent.onEnd((evtRunId: string) => {
          if (evtRunId !== snap.runId) return
          safeClose()
        })
        unsubError = events!.agent.onError(
          (evtRunId: string, message: string) => {
            if (evtRunId !== snap.runId) return
            safeError(new Error(message))
          }
        )
      }

      // Replay buffered chunks as a single coalesced enqueue. SSE frames
      // are delimited by `\n\n`; joining preserves the boundaries because
      // each chunks[i] is already a decoded string from `TextDecoder`.
      if (snap.chunks.length > 0) {
        controller.enqueue(encoder.encode(snap.chunks.join("")))
      }

      if (snap.state === "ended") {
        safeClose()
      } else if (snap.state === "errored") {
        safeError(new Error(snap.error ?? "Run errored"))
      }
    },
    cancel() {
      // Stream consumer cancelled — local cleanup only. Do NOT cancel
      // the main-process run; this fires on refresh too.
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function buildLiveResponse(
  runId: string,
  abortSignal: AbortSignal | null | undefined
): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let unsubChunk: (() => void) | null = null
      let unsubEnd: (() => void) | null = null
      let unsubError: (() => void) | null = null

      const cleanup = () => {
        unsubChunk?.()
        unsubEnd?.()
        unsubError?.()
      }

      const safeClose = () => {
        if (closed) return
        closed = true
        cleanup()
        try {
          controller.close()
        } catch {
          // already closed
        }
      }

      const safeError = (err: unknown) => {
        if (closed) return
        closed = true
        cleanup()
        try {
          controller.error(err)
        } catch {
          // already closed
        }
      }

      unsubChunk = events!.agent.onChunk((evtRunId: string, chunk: string) => {
        if (evtRunId !== runId) return
        controller.enqueue(encoder.encode(chunk))
      })
      unsubEnd = events!.agent.onEnd((evtRunId: string) => {
        if (evtRunId !== runId) return
        safeClose()
      })
      unsubError = events!.agent.onError(
        (evtRunId: string, message: string) => {
          if (evtRunId !== runId) return
          safeError(new Error(message))
        }
      )

      if (abortSignal) {
        if (abortSignal.aborted) {
          // Local stream is dead, but the main-process run keeps going so
          // we can resume after refresh. Renderer-side cleanup only.
          safeError(new DOMException("Aborted", "AbortError"))
          return
        }
        abortSignal.addEventListener(
          "abort",
          () => {
            safeError(new DOMException("Aborted", "AbortError"))
          },
          { once: true }
        )
      }
    },
    cancel() {
      // Local cleanup only — see note in handleReconnect.
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}
