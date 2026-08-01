// ── Active Thread Provider ───────────────────────────────────────────────────
//
// Wraps `useAgentEvents` (AgentController events over IPC) with thread/project
// metadata loading (title, sidebar list, selected model, voice). Mirrors the
// exported hook API the old ai-sdk `useChat`-backed version had — thread-shell
// consumes the same field names (`messages`, `status`, `sendMessage`,
// `cancelRun`, ...) — with two additions Task 6 needs: `suspension` and
// `respondSuspension`, and one behavior drop: this no longer merges the
// JSON-store's persisted message history into the live view. Controller
// storage (`agent.listMessages`, folded in by `useAgentEvents`) is the source
// of truth for controller-era conversations now — see task-6-report.md.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { apis, events } from "@/types/electron-api"
import type {
  UIMessage,
  StoredThread,
  StoredProject,
  ProjectMeta,
} from "@electron/store/types"
import type { DynamicToolUIPart } from "ai"
import {
  useAgentEvents,
  type SerializedAgentMessage,
  type AgentSuspension,
} from "@/hooks/use-agent-events"

// ── Message shape adapter ────────────────────────────────────────────────────
//
// `SerializedAgentMessage.content.parts` is `MastraMessagePart[]` — an ai-sdk
// *v4*-shaped legacy format (`MastraMessageContentV2`, `format: 2`; see
// `node_modules/@mastra/core/dist/agent/message-list/state/types.d.ts`), not
// the ai-sdk *v5* `UIMessage["parts"]` shape `src/components/thread/
// tool-usage.tsx` (and the `ai` v6 package this app is on) renders. The two
// diverge in exactly the ways the task brief called out:
//   - reasoning: v4 carries the text under a `reasoning` field, v5 under `text`.
//   - tool calls: v4 nests `{toolCallId, toolName, args, state, result?}`
//     under a `type: "tool-invocation"` part's `toolInvocation` field; v5
//     flattens those directly onto a `type: "tool-<name>"` (or
//     `"dynamic-tool"`, used here since the controller's tool set isn't a
//     compile-time union) part, and uses a different state vocabulary for
//     its three "core" states (`partial-call`/`call`/`result` vs
//     `input-streaming`/`input-available`/`output-available`) — the four
//     suspend/approval states (`approval-requested`, `approval-responded`,
//     `output-error`, `output-denied`) are spelled identically in both.
//
// Mapping onto `UIMessage["parts"]` here (rather than teaching
// tool-usage.tsx a second part vocabulary) keeps the existing renderer —
// text/reasoning/tool-* clustering, read/edit/terminal/ask_user/present_files
// special-casing — visually unchanged, per the brief.

/** Loosely-typed escape hatch for the part fields this mapper reads. The
 * precise nested Mastra union types (`MastraMessagePart`) don't narrow
 * cleanly through `Omit`/intersection combinators for a switch-on-`type`
 * mapper; this is a deliberate "trust the wire shape" boundary — the same
 * kind of cast already used at other IPC-serialization boundaries in this
 * codebase (see `electron/agent/controller.ts`'s `ToolsInput` cast comment). */
interface LooseMastraPart {
  type: string
  text?: string
  reasoning?: string
  toolInvocation?: {
    toolCallId: string
    toolName: string
    args?: unknown
    state: string
    result?: unknown
    errorText?: string
  }
}

/** `partial-call`/`call`/`result` (v4) -> `input-streaming`/`input-available`/
 * `output-available` (v5). The other four legacy states already spell the
 * same as their v5 counterparts, so they pass through unchanged. */
function mapToolState(state: string): DynamicToolUIPart["state"] {
  if (state === "partial-call") return "input-streaming"
  if (state === "call") return "input-available"
  if (state === "result") return "output-available"
  return state as DynamicToolUIPart["state"]
}

function mapPart(
  raw: SerializedAgentMessage["content"]["parts"][number]
): UIMessage["parts"][number] | null {
  const part = raw as unknown as LooseMastraPart

  if (part.type === "text") {
    return { type: "text", text: part.text ?? "" }
  }

  if (part.type === "reasoning") {
    // Always "streaming" — the render layer (`isReasoningPartStreaming` in
    // tool-usage.tsx) ANDs this with `isMessageStreaming`, which is the
    // actually-authoritative signal; there's no reliable per-part
    // streaming flag in the v4 shape to carry instead.
    return { type: "reasoning", text: part.reasoning ?? "", state: "streaming" }
  }

  if (part.type === "tool-invocation" && part.toolInvocation) {
    const inv = part.toolInvocation
    // Double cast: the v4 `toolInvocation` fields don't structurally satisfy
    // v5's per-state discriminated `DynamicToolUIPart` union (e.g. `output`
    // typed `never` while `state` is `"input-streaming"`). This data only
    // ever flows into read-only rendering, never back through a provider
    // API, so trusting the runtime shape here is safe.
    return {
      type: "dynamic-tool",
      toolName: inv.toolName,
      toolCallId: inv.toolCallId,
      state: mapToolState(inv.state),
      input: inv.args,
      output: inv.result,
      errorText: inv.errorText,
    } as unknown as UIMessage["parts"][number]
  }

  if (part.type === "step-start") {
    return { type: "step-start" }
  }

  // source-url / source-document / file / data-* parts: no renderer for
  // these in tool-usage.tsx (same as the old ai-sdk pipeline) — dropped
  // rather than mis-rendered.
  return null
}

function toUIMessage(message: SerializedAgentMessage): UIMessage {
  return {
    id: message.id,
    role: message.role as "user" | "assistant",
    parts: message.content.parts
      .map(mapPart)
      .filter((p): p is UIMessage["parts"][number] => p !== null),
  }
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ThreadStatus = "idle" | "running" | "error"

interface ActiveThreadContextValue {
  projectId: string
  threadId: string | null

  project: StoredProject | null
  thread: StoredThread | null
  threads: StoredThread[]
  messages: UIMessage[]
  status: ThreadStatus
  error: string | null
  /** Active `ask_user`/`submit_plan` suspension awaiting a response, or null. */
  suspension: AgentSuspension | null

  selectedModel: string
  voiceId: string | null
  voiceName: string | null

  input: string
  setInput: (value: string) => void

  sendMessage: (text: string) => Promise<void>
  /** Re-issue the last user message as a new message. Unlike the old
   * ai-sdk `regenerate()`, this does not replace the failed assistant turn
   * in place — the controller exposes no regenerate-in-place primitive, so
   * this appends a new user turn instead (see task-6-report.md). */
  retryRun: () => void
  /** Dismiss the current error without re-running. */
  dismissError: () => void
  cancelRun: () => void
  /** Resolve the active suspension (`ask_user`/`submit_plan`). */
  respondSuspension: (toolCallId: string, resumeData: unknown) => Promise<void>
  createThread: (title?: string) => Promise<StoredThread>
  renameThread: (title: string) => Promise<void>
  deleteThread: () => Promise<void>
  setSelectedModel: (fullModelId: string) => Promise<void>

  isLoaded: boolean
}

const ActiveThreadContext = createContext<ActiveThreadContextValue | null>(null)

interface ActiveThreadProviderProps {
  projectId: string
  threadId: string | null
  children: ReactNode
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function ActiveThreadProvider({
  projectId,
  threadId,
  children,
}: ActiveThreadProviderProps) {
  const navigate = useNavigate()

  const [project, setProject] = useState<StoredProject | null>(null)
  const [meta, setMeta] = useState<ProjectMeta | null>(null)
  const [thread, setThread] = useState<StoredThread | null>(null)
  const [threads, setThreads] = useState<StoredThread[]>([])
  const [input, setInput] = useState("")
  const [isLoaded, setIsLoaded] = useState(false)

  const agentEvents = useAgentEvents(projectId, threadId)

  const messages = useMemo(
    () =>
      agentEvents.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map(toUIMessage),
    [agentEvents.messages]
  )

  // The reducer backing `useAgentEvents` only replaces `error` with a new
  // object on a genuine `error`/`hydrate_error` dispatch (untouched by e.g.
  // `display_state_changed`), so keying off it here correctly un-dismisses
  // only on a new error, not on unrelated state churn. "Adjusting state
  // during render" (react.dev/learn/you-might-not-need-an-effect#adjusting-
  // some-state-when-a-prop-changes) rather than an effect — avoids the extra
  // render-then-effect-then-render cascade an effect-based reset would cause.
  const [dismissedError, setDismissedError] = useState(false)
  const [lastSeenError, setLastSeenError] = useState(agentEvents.error)
  if (agentEvents.error !== lastSeenError) {
    setLastSeenError(agentEvents.error)
    setDismissedError(false)
  }

  // ── Load project/thread metadata on mount / threadId change ────────────
  useEffect(() => {
    if (!apis) return

    const storeApi = apis.store
    let cancelled = false

    const load = async () => {
      setIsLoaded(false)
      const [proj, threadList] = await Promise.all([
        storeApi.getProject(projectId),
        storeApi.listThreads(projectId),
      ])

      if (cancelled) return

      setProject(proj?.project ?? null)
      setMeta(proj?.meta ?? null)
      setThreads(threadList)

      if (threadId) {
        const t = await storeApi.getThread(projectId, threadId)

        if (cancelled) return

        // Stale threadId — thread no longer exists. Bounce back to the
        // project route so ProjectPage can pick a valid thread (or land on
        // the empty new-thread state if none remain).
        if (!t) {
          navigate(`/projects/${projectId}`, { replace: true })
          return
        }

        setThread(t)

        // Keep the project's "last opened" pointer in sync for any
        // navigation path (sidebar click, deep link, back/forward).
        if (proj?.project && proj.project.lastThreadId !== threadId) {
          void storeApi.updateProject(projectId, { lastThreadId: threadId })
        }
      } else {
        setThread(null)
      }

      setIsLoaded(true)
    }

    load()

    return () => {
      cancelled = true
    }
  }, [projectId, threadId, navigate])

  // ── Subscribe to thread list changes ───────────────────────────────────
  useEffect(() => {
    const unsub = events?.store.onThreadsChanged(
      (evtProjectId: string, updatedThreads: StoredThread[]) => {
        if (evtProjectId !== projectId) return
        setThreads(updatedThreads)
        if (threadId) {
          const updated = updatedThreads.find((t) => t.id === threadId)
          if (updated) setThread(updated)
        }
      }
    )
    return () => unsub?.()
  }, [projectId, threadId])

  // ── Subscribe to project list changes ──────────────────────────────────
  useEffect(() => {
    const unsub = events?.store.onProjectsChanged(
      (updatedProjects: StoredProject[]) => {
        const updated = updatedProjects.find((p) => p.id === projectId)
        if (updated) setProject(updated)
        // Project meta (voice, model) can change in other windows too — fetch
        // a fresh meta whenever the projects list broadcasts. Cheap, and keeps
        // the gear-icon dialog in sync without its own event channel.
        if (apis) {
          void apis.store.getProject(projectId).then((proj) => {
            if (proj?.meta) setMeta(proj.meta)
          })
        }
      }
    )
    return () => unsub?.()
  }, [projectId])

  // ── Actions ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || !apis) return

      if (!threadId) {
        // No thread yet: create the sidebar record and hand off to the
        // freshly-mounted ThreadPage's own ActiveThreadProvider (routed by
        // the `key={projectId:threadId}` remount in thread/index.tsx) via
        // the same `location.state.pendingPrompt` mechanism thread-shell.tsx
        // already uses for the dashboard's "new thread" flow. This provider
        // instance's `agentEvents.send` is bound to `threadId === null` for
        // its whole lifetime (useAgentEvents closes over its own params) —
        // calling it here would silently no-op, so the message must be sent
        // by the instance that actually owns the new thread's session.
        const newThread = await apis.store.createThread(projectId)
        await apis.store.updateProject(projectId, {
          lastThreadId: newThread.id,
        })
        setInput("")
        navigate(`/projects/${projectId}/threads/${newThread.id}`, {
          replace: true,
          state: { pendingPrompt: trimmed },
        })
        return
      }

      setInput("")
      await agentEvents.send(trimmed)
    },
    [projectId, threadId, navigate, agentEvents]
  )

  const retryRun = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    if (!lastUser) return
    void agentEvents.send(getMessageText(lastUser))
  }, [messages, agentEvents])

  const dismissError = useCallback(() => {
    setDismissedError(true)
  }, [])

  const cancelRun = useCallback(() => {
    void agentEvents.cancel()
  }, [agentEvents])

  const respondSuspension = useCallback(
    (toolCallId: string, resumeData: unknown) =>
      agentEvents.respond(toolCallId, resumeData),
    [agentEvents]
  )

  const createThread = useCallback(
    async (title?: string) => {
      if (!apis) throw new Error("APIs not available")
      const newThread = await apis.store.createThread(projectId, title)
      navigate(`/projects/${projectId}/threads/${newThread.id}`)
      return newThread
    },
    [projectId, navigate]
  )

  const setSelectedModel = useCallback(
    async (fullModelId: string) => {
      if (!apis) return
      await apis.store.updateProjectMeta(projectId, {
        selectedModel: fullModelId,
      })
      setMeta((prev) => (prev ? { ...prev, selectedModel: fullModelId } : prev))
    },
    [projectId]
  )

  const renameThread = useCallback(
    async (title: string) => {
      if (!apis || !threadId) return
      const trimmed = title.trim()
      if (!trimmed) return
      await apis.store.updateThread(projectId, threadId, { title: trimmed })
    },
    [projectId, threadId]
  )

  const deleteThread = useCallback(async () => {
    if (!apis || !threadId) return
    await apis.store.deleteThread(projectId, threadId)
    const remaining = threads.filter((t) => t.id !== threadId)
    if (remaining.length > 0) {
      await apis.store.updateProject(projectId, {
        lastThreadId: remaining[0].id,
      })
      navigate(`/projects/${projectId}/threads/${remaining[0].id}`)
    } else {
      await apis.store.updateProject(projectId, { lastThreadId: null })
      navigate("/")
    }
  }, [projectId, threadId, threads, navigate])

  // ── Context value ──────────────────────────────────────────────────────

  const error = dismissedError ? null : (agentEvents.error?.message ?? null)

  const value = useMemo<ActiveThreadContextValue>(
    () => ({
      projectId,
      threadId,
      project,
      thread,
      threads,
      messages,
      status: agentEvents.status,
      error,
      suspension: agentEvents.suspension,
      selectedModel: meta?.selectedModel ?? "",
      voiceId: meta?.voiceId ?? null,
      voiceName: meta?.voiceName ?? null,
      input,
      setInput,
      sendMessage,
      retryRun,
      dismissError,
      cancelRun,
      respondSuspension,
      createThread,
      renameThread,
      deleteThread,
      setSelectedModel,
      isLoaded,
    }),
    [
      projectId,
      threadId,
      project,
      thread,
      threads,
      messages,
      agentEvents.status,
      agentEvents.suspension,
      error,
      meta,
      input,
      sendMessage,
      retryRun,
      dismissError,
      cancelRun,
      respondSuspension,
      createThread,
      renameThread,
      deleteThread,
      setSelectedModel,
      isLoaded,
    ]
  )

  return (
    <ActiveThreadContext.Provider value={value}>
      {children}
    </ActiveThreadContext.Provider>
  )
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useActiveThread() {
  const context = useContext(ActiveThreadContext)
  if (!context) {
    throw new Error(
      "useActiveThread must be used within an ActiveThreadProvider"
    )
  }
  return context
}
