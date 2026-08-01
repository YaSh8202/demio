// ── Agent IPC Handlers ───────────────────────────────────────────────────────
//
// Controller-backed surface. Every AgentController event for a session is
// broadcast as `agent:onEvent` keyed by `${projectId}:${threadId}`; the
// renderer rebuilds message + progress state from events and can re-hydrate
// after refresh via `getDisplayState`.
//
// `sendMessage`/`reconnect`/`cancel` used to drive the hand-rolled
// orchestrator/runs/sessions SSE-byte-pump (see electron/agent/orchestrator.ts,
// runs.ts, sessions.ts) — that path stays importable elsewhere until Task 7
// deletes it, but this handler no longer calls into it. `reconnect` is kept
// as a deprecated no-op stub purely so src/lib/ipc-chat-transport.ts (still
// on the old useChat/SSE transport until Task 6) keeps compiling; it no
// longer does anything useful.

import fs from "node:fs"
import path from "node:path"
import { BrowserWindow } from "electron"
import log from "../lib/logger"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import { getProject } from "../store"
import { getOrCreateSession } from "../agent/controller"
import { DEFAULT_MODEL_ID } from "../agent/types"
import { ensureWorkspace } from "../agent/workspace"
import type { UIMessage } from "../store/types"
import type { SubmitPlanSuspendPayload } from "@mastra/core/tools"

function broadcast(channel: string, ...args: unknown[]) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(DEMIO_EVENT_CHANNEL, channel, ...args)
    }
  })
}

const subscribed = new Set<string>()

// Maps inside events/displayState do not survive the preload JSON boundary —
// convert to plain objects/arrays before broadcast.
function serializeEvent(event: unknown): unknown {
  return JSON.parse(
    JSON.stringify(event, (_k, v) =>
      v instanceof Map ? Object.fromEntries(v) : v
    )
  )
}

/**
 * For a `submit_plan` `tool_suspended` event, read the plan file content off
 * disk and attach it as `planContent` on the (already plain-object)
 * serialized event so the renderer can display the plan without a separate
 * round trip. `suspendPayload.path` is validated to resolve inside the
 * thread's own workspace directory before being read — the path comes from
 * inside a suspended tool call, so it is untrusted input from the model.
 */
function attachPlanContent(
  serialized: Record<string, unknown>,
  threadId: string
): Record<string, unknown> {
  if (serialized["toolName"] !== "submit_plan") return serialized

  const suspendPayload = serialized["suspendPayload"] as
    | Partial<SubmitPlanSuspendPayload>
    | undefined
  const rawPath = suspendPayload?.path
  if (typeof rawPath !== "string" || rawPath.length === 0) return serialized

  const cwd = ensureWorkspace(threadId)
  const resolved = path.resolve(cwd, rawPath)
  const isInsideWorkspace =
    resolved === cwd || resolved.startsWith(cwd + path.sep)
  if (!isInsideWorkspace) {
    log.error(
      `[agent] submit_plan path escapes workspace, refusing to read: ${rawPath}`
    )
    return serialized
  }

  try {
    return {
      ...serialized,
      planContent: fs.readFileSync(resolved, "utf8"),
    }
  } catch (error) {
    log.error("[agent] failed to read submit_plan file:", error)
    return serialized
  }
}

async function ensureSubscribed(projectId: string, threadId: string) {
  const key = `${projectId}:${threadId}`
  if (subscribed.has(key)) return
  subscribed.add(key)
  const session = await getOrCreateSession(projectId, threadId)
  // Promise-chain serialization: async handlers must not interleave
  // (mastracode:tui/src/tui/setup.ts:571-590). Broadcast is sync today, but
  // keep the chain — persistence hooks land here later.
  let queue = Promise.resolve()
  session.subscribe((event: unknown) => {
    queue = queue.then(() => {
      try {
        let serialized = serializeEvent(event) as Record<string, unknown>
        if (serialized["type"] === "tool_suspended") {
          serialized = attachPlanContent(serialized, threadId)
        }
        broadcast("agent:onEvent", key, serialized)
      } catch (error) {
        log.error("[agent] event broadcast failed:", error)
      }
    })
  })
}

function extractText(message: UIMessage): string {
  return (message.parts ?? [])
    .map((p) => (p.type === "text" ? (p as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n")
}

export const agentHandlers = {
  sendMessage: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    body: { message: UIMessage; modelId?: string }
  ) => {
    await ensureSubscribed(projectId, threadId)
    const session = await getOrCreateSession(projectId, threadId)
    const modelId =
      body.modelId ||
      getProject(projectId)?.meta?.selectedModel ||
      DEFAULT_MODEL_ID
    // `session.model.set` only updates the in-memory selection (no thread
    // persistence, no `model_changed` event) — SessionModel.set docstring,
    // agent-controller/session.d.ts:630-633. That's the right call here: we
    // want THIS run to use the requested/default model without silently
    // persisting it as the thread's remembered model (that's a distinct,
    // explicit "switch model" action `session.model.switch(...)` would own).
    session.model.set({ modelId })
    // Fire and forget — progress arrives via agent:onEvent. While a run is
    // active this becomes a follow-up/steer decision internally; Session's
    // own `sendMessage` queues/streams as appropriate.
    void session
      .sendMessage({ content: extractText(body.message) })
      .catch((error: unknown) => {
        log.error("[agent] sendMessage failed:", error)
        broadcast("agent:onEvent", `${projectId}:${threadId}`, {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return { ok: true }
  },

  respondSuspension: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    body: { toolCallId: string; resumeData: unknown }
  ) => {
    await ensureSubscribed(projectId, threadId)
    const session = await getOrCreateSession(projectId, threadId)

    const pending = session.suspensions.get({ toolCallId: body.toolCallId })
    const isSubmitPlan = pending?.toolName === "submit_plan"
    const resumeData = body.resumeData as
      | { action?: "approved" | "rejected"; title?: string; plan?: string }
      | undefined

    // `session.respondToToolSuspension` already routes submit_plan resumes
    // through its own plan-approval path (mode switch on approve) — see
    // agent-controller/session.d.ts:1276-1286. Demio layers its own
    // `activePlan` controller-state field on top (execute mode's
    // instructions read it), which the built-in tool knows nothing about,
    // so we set it ourselves before resuming.
    if (isSubmitPlan && resumeData?.action === "approved") {
      await session.state.set({
        activePlan: {
          title: resumeData.title ?? "",
          plan: resumeData.plan ?? "",
          approvedAt: new Date().toISOString(),
        },
      })
    }

    await session.respondToToolSuspension({
      toolCallId: body.toolCallId,
      resumeData: body.resumeData,
    })

    // On rejection we don't want the built-in tool's auto-continue (it just
    // re-feeds the model the rejection + feedback and lets it keep
    // streaming in the same turn) — Demio wants a hard stop so the
    // rejection + feedback becomes context for the user's NEXT message
    // rather than an in-turn auto-revision.
    if (isSubmitPlan && resumeData?.action === "rejected") {
      session.abort()
    }

    return { ok: true }
  },

  cancel: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    const session = await getOrCreateSession(projectId, threadId)
    // Abort guard must cover BOTH states: isRunning() is false while a tool
    // sits in suspend() (mastracode:tui/src/tui/setup.ts:70) — abort anyway
    // so a parked ask_user/submit_plan also cancels.
    session.abort()
    return { cancelled: true }
  },

  getDisplayState: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    await ensureSubscribed(projectId, threadId)
    const session = await getOrCreateSession(projectId, threadId)
    // SessionDisplayState.get() is non-nullable (session.d.ts:941) — it
    // always returns a snapshot, defaulted/idle when nothing has run yet.
    // The `| null` in this method's documented return type is for callers
    // that haven't mounted a session at all; that's not a state this
    // handler can observe once ensureSubscribed has run.
    return serializeEvent(session.displayState.get())
  },

  // History for thread mount / refresh-reattach. Controller storage is the
  // source of truth for controller-era conversations (ADR-007 amended);
  // mirrors mastracode renderExistingMessages (tui/src/tui/render-messages.ts:843).
  listMessages: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    limit?: number
  ) => {
    await ensureSubscribed(projectId, threadId)
    const session = await getOrCreateSession(projectId, threadId)
    const messages = await session.thread.listActiveMessages({
      limit: limit ?? 200,
    })
    return serializeEvent(messages)
  },

  /**
   * @deprecated Dead stub kept only so src/lib/ipc-chat-transport.ts (old
   * useChat/SSE renderer path, replaced in Task 6) still type-checks —
   * `apis.agent.reconnect` no longer has a backing run buffer to read from
   * (runs.ts is no longer wired up by this handler). Always returns null,
   * which ipc-chat-transport.ts already treats as "no active run".
   */
  reconnect: async (
    _event: Electron.IpcMainInvokeEvent,
    _projectId: string,
    _threadId: string
  ) => {
    return null
  },
} satisfies NamespaceHandlers
