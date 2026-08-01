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

// Maps AND Errors inside events/displayState do not survive the preload JSON
// boundary as anything useful on their own: `JSON.stringify` drops Maps
// entirely, and Error's `message`/`stack` are non-enumerable so a bare Error
// serializes to `{}`. The real `error` controller event carries `error:
// Error` (types.d.ts `type: 'error'` variant) — without this replacer every
// error the renderer receives over IPC is an empty object.
function serializeEvent(event: unknown): unknown {
  return JSON.parse(
    JSON.stringify(event, (_k, v) => {
      if (v instanceof Map) return Object.fromEntries(v)
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack }
      }
      return v
    })
  )
}

/** Wrap an unknown catch value as an Error so it serializes via the same
 * `serializeEvent` Error branch as real controller `error` events — one
 * code path, one shape (`{name, message, stack}`), instead of the old
 * bug where synthetic broadcasts sent a bare string while real events sent
 * an (accidentally blanked) Error. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function broadcastError(key: string, error: unknown) {
  broadcast(
    "agent:onEvent",
    key,
    serializeEvent({ type: "error", error: toError(error) })
  )
}

/**
 * Read a `submit_plan` plan file off disk, validating that `rawPath`
 * resolves inside the thread's own workspace directory before reading it —
 * the path comes from inside a (suspended) tool call, so it's untrusted
 * input from the model. Returns `null` (and logs) on any invalid/unreadable
 * path rather than throwing, so callers can degrade gracefully instead of
 * persisting placeholder content.
 */
function readValidatedPlanFile(
  threadId: string,
  rawPath: unknown
): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null

  const cwd = ensureWorkspace(threadId)
  const resolved = path.resolve(cwd, rawPath)
  const isInsideWorkspace =
    resolved === cwd || resolved.startsWith(cwd + path.sep)
  if (!isInsideWorkspace) {
    log.error(
      `[agent] submit_plan path escapes workspace, refusing to read: ${rawPath}`
    )
    return null
  }

  try {
    return fs.readFileSync(resolved, "utf8")
  } catch (error) {
    log.error("[agent] failed to read submit_plan file:", error)
    return null
  }
}

/** First `# Heading` line in the plan markdown, else the file's basename, else a fallback. */
function derivePlanTitle(content: string, rawPath: string): string {
  const heading = content.match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim()
  const base = path.basename(rawPath)
  return base.length > 0 ? base : "Plan"
}

/**
 * For a `submit_plan`-suspended entry (a `tool_suspended` event, or one
 * `pendingSuspensions` map entry off display state), read the plan file
 * content off disk and attach it as a sibling `planContent` field so the
 * renderer can display the plan without a separate round trip. No-ops for
 * any other tool / an unreadable path.
 */
function attachPlanContent(
  serialized: Record<string, unknown>,
  threadId: string
): Record<string, unknown> {
  if (serialized["toolName"] !== "submit_plan") return serialized

  const suspendPayload = serialized["suspendPayload"] as
    | Partial<SubmitPlanSuspendPayload>
    | undefined
  const content = readValidatedPlanFile(threadId, suspendPayload?.path)
  if (content === null) return serialized

  return { ...serialized, planContent: content }
}

/** Apply {@link attachPlanContent} to every `pendingSuspensions` entry of an
 * already-`serializeEvent`d display-state snapshot (used by `getDisplayState`
 * on reconnect, and by the first-subscribe resync — see `ensureSubscribed`).
 * A refresh mid plan-approval must see the same `planContent` a live
 * `tool_suspended` broadcast would have carried. */
function enrichPendingSuspensions(
  serializedDisplayState: Record<string, unknown>,
  threadId: string
): Record<string, unknown> {
  const pendingSuspensions = serializedDisplayState["pendingSuspensions"]
  if (!pendingSuspensions || typeof pendingSuspensions !== "object") {
    return serializedDisplayState
  }
  const enriched: Record<string, unknown> = {}
  for (const [toolCallId, entry] of Object.entries(
    pendingSuspensions as Record<string, unknown>
  )) {
    enriched[toolCallId] = attachPlanContent(
      entry as Record<string, unknown>,
      threadId
    )
  }
  return { ...serializedDisplayState, pendingSuspensions: enriched }
}

// In-flight/complete subscribe promises, keyed by `${projectId}:${threadId}`.
// A Map<string, Promise<void>> (rather than a Set flagged before the await)
// so concurrent callers all await the SAME subscribe sequence instead of a
// second caller racing ahead of `session.subscribe(...)` attaching — and so
// a rejected attempt (e.g. getOrCreateSession throwing) is removed from the
// cache instead of permanently marking the key "subscribed" with no listener
// ever attached.
const ensureSubscriptions = new Map<string, Promise<void>>()

function ensureSubscribed(projectId: string, threadId: string): Promise<void> {
  const key = `${projectId}:${threadId}`
  const inFlight = ensureSubscriptions.get(key)
  if (inFlight) return inFlight

  const promise = subscribeSession(projectId, threadId, key).catch(
    (error: unknown) => {
      ensureSubscriptions.delete(key)
      throw error
    }
  )
  ensureSubscriptions.set(key, promise)
  return promise
}

async function subscribeSession(
  projectId: string,
  threadId: string,
  key: string
): Promise<void> {
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

  // Subscribe-after-thread-selection gap: by the time `getOrCreateSession`
  // above resolves, its underlying `AgentController.createSession(...)` has
  // already run to completion — workspace init, thread bind/create,
  // mode/model selection all happened and any events they emitted
  // (workspace_ready, thread_created/thread_changed, mode_changed, ...) went
  // out with zero listeners attached (agent-controller-ByW51eCC.js:4351-4519
  // is one atomic async call; there's no public "construct unbound, let the
  // caller subscribe, then bind thread/workspace" seam on
  // `AgentController.createSession` to sequence around instead). Falling
  // back to MastraCode's own pattern for this
  // (tui/src/tui/mastra-tui.ts:637-656): stay subscribe-after, but
  // immediately resync a `display_state_changed` built from the CURRENT
  // snapshot right after subscribing, so first-mount never loses state —
  // `displayState.get()` already folds in everything those missed events
  // would have produced (isRunning, pendingSuspensions, tasks, etc).
  const displayState = enrichPendingSuspensions(
    serializeEvent(session.displayState.get()) as Record<string, unknown>,
    threadId
  )
  broadcast("agent:onEvent", key, {
    type: "display_state_changed",
    displayState,
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
    const key = `${projectId}:${threadId}`
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
        broadcastError(key, error)
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
    const key = `${projectId}:${threadId}`

    const pending = session.suspensions.get({ toolCallId: body.toolCallId })
    const isSubmitPlan = pending?.toolName === "submit_plan"
    const resumeData = body.resumeData as
      | { action?: "approved" | "rejected" }
      | undefined

    if (!isSubmitPlan) {
      // Session's general resume path (`resumeToolCall`, driving the
      // subscribed-thread "resume boundary waiter" —
      // session.d.ts:1314-1331) only resolves once the resumed run reaches
      // its next boundary; for e.g. an `ask_user` answer that's however
      // long the model keeps running afterward — potentially minutes. Only
      // `submit_plan` gets a dedicated, promptly-resolving path
      // (`handlePlanApprovalResume`, session.d.ts:1276-1293). So: for
      // everything else, fire-and-forget — progress still arrives via
      // agent:onEvent, and the IPC call itself must not pend for the
      // remainder of the turn. submit_plan below keeps the awaited
      // semantics because the reject-then-abort ordering needs it.
      void session
        .respondToToolSuspension({
          toolCallId: body.toolCallId,
          resumeData: body.resumeData,
        })
        .catch((error: unknown) => {
          log.error("[agent] respondToToolSuspension failed:", error)
          broadcastError(key, error)
        })
      return { ok: true }
    }

    // `session.respondToToolSuspension` already routes submit_plan resumes
    // through its own plan-approval path (mode switch on approve) — see
    // agent-controller/session.d.ts:1276-1286. Demio layers its own
    // `activePlan` controller-state field on top (execute mode's
    // instructions read it), which the built-in tool knows nothing about,
    // so we set it ourselves before resuming — reading the plan file back
    // off disk (re-validated) rather than trusting whatever `title`/`plan`
    // the renderer echoes back in `resumeData`: nothing guarantees the
    // renderer actually sends them, and silently persisting
    // `{title: "", plan: ""}` would poison execute mode's context with a
    // plan that doesn't exist.
    if (resumeData?.action === "approved") {
      const pendingEntry = session.displayState
        .get()
        .pendingSuspensions.get(body.toolCallId)
      const suspendPayload = pendingEntry?.suspendPayload as
        | Partial<SubmitPlanSuspendPayload>
        | undefined
      const rawPath = suspendPayload?.path
      const content = readValidatedPlanFile(threadId, rawPath)

      if (content === null) {
        log.error(
          `[agent] submit_plan approval for toolCallId=${body.toolCallId} has no readable plan file (path=${String(rawPath)}) — proceeding without activePlan state`
        )
        broadcastError(
          key,
          new Error(
            "Plan approval could not read the plan file from disk; activePlan state was not set."
          )
        )
      } else {
        await session.state.set({
          activePlan: {
            title: derivePlanTitle(content, rawPath ?? ""),
            plan: content,
            approvedAt: new Date().toISOString(),
          },
        })
      }
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
    if (resumeData?.action === "rejected") {
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
    const serialized = serializeEvent(session.displayState.get()) as Record<
      string,
      unknown
    >
    // A refresh mid plan-approval must see the same `planContent` a live
    // `tool_suspended` broadcast would have carried — a bare path with no
    // plan body otherwise.
    return enrichPendingSuspensions(serialized, threadId)
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
