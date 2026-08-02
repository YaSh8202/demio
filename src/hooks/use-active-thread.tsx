// ── Active Thread Provider ───────────────────────────────────────────────────
//
// Wraps `useAgentEvents` (AgentController events over IPC) with thread/project
// metadata loading (title, sidebar list, selected model, voice). Mirrors the
// exported hook API the old ai-sdk `useChat`-backed version had — thread-shell
// consumes the same field names (`messages`, `status`, `sendMessage`,
// `cancelRun`, ...) — with two additions Task 6 needs: `suspension` and
// `respondSuspension`.
//
// Controller storage (`agent.listMessages`, folded in by `useAgentEvents`) is
// the source of truth for controller-era conversations. It is NOT merged with
// the JSON-store's persisted history for those threads (no live cross-window
// sync of store messages either) — but ADR-007 requires legacy (pre-controller)
// threads to remain readable, and the controller's LibSQLStore has no history
// for a thread that predates it. See the `legacyMessages` fallback below.

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
  type WorkflowState,
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
    /** Sibling of `result` when `state === "result"` — set by
     * `AgentController.processStreamChunk`'s `"tool-result"` case
     * (compiled: `node_modules/@mastra/core/dist/agent-controller-
     * ByW51eCC.js` ~line 407-436): `existing.toolInvocation =
     * Object.assign(existing.toolInvocation, { state: "result", result,
     * isError })`, where `isError = getBoolean(toolResult.isError, false)`.
     * A thrown tool error (e.g. `generateDemoTool`'s workflow-failure
     * throws) surfaces to the controller as a `"tool-result"` chunk with
     * `isError: true`, NOT as a `state: "output-error"` toolInvocation —
     * there is no separate `errorText` written alongside it in this path,
     * only `result` (holding the error payload). Not part of the public
     * `MastraToolInvocation` `.d.ts` (`node_modules/@mastra/core/dist/agent/
     * message-list/state/types.d.ts`), but present on the actual persisted/
     * serialized wire shape — hence read defensively here rather than typed
     * as required. */
    isError?: boolean
  }
}

/** `partial-call`/`call`/`result` (v4) -> `input-streaming`/`input-available`/
 * `output-available` (v5). The other four legacy states already spell the
 * same as their v5 counterparts, so they pass through unchanged.
 *
 * `result` needs a second look before mapping straight to
 * `"output-available"`: the controller persists a *failed* tool call
 * (thrown error) as `state: "result"` with a sibling `isError: true` field
 * (see `LooseMastraPart.toolInvocation.isError`'s doc comment) rather than
 * as a distinct `"output-error"` state. Ignoring that flag is exactly what
 * let a failed `generate_demo` rehydrate as a green "Video ready" footer —
 * `workflow-progress.tsx` keys its success/error styling off
 * `toolState === "output-error"` vs `"output-available"`. */
function mapToolState(
  state: string,
  isError: boolean | undefined
): DynamicToolUIPart["state"] {
  if (state === "partial-call") return "input-streaming"
  if (state === "call") return "input-available"
  if (state === "result") return isError ? "output-error" : "output-available"
  return state as DynamicToolUIPart["state"]
}

/** Best-effort error message extraction for the `state: "result", isError:
 * true` shape (see `mapToolState`'s doc comment) — that path has no
 * `errorText` field of its own, only `result` holding whatever the thrown
 * error's display-transformed payload was (a string, or an object carrying
 * `.message`). Falls back to `undefined` so callers can supply their own
 * generic copy (`workflow-progress.tsx` already does: `errorText ||
 * "Demo generation failed."`). */
function errorTextFromResult(result: unknown): string | undefined {
  if (typeof result === "string") return result
  if (
    result &&
    typeof result === "object" &&
    "message" in result &&
    typeof (result as { message?: unknown }).message === "string"
  ) {
    return (result as { message: string }).message
  }
  return undefined
}

/**
 * Controller tool names -> legacy short names.
 * `src/components/thread/tool-usage.tsx`'s `ThreadToolUsage`/`getClusterKind`
 * dispatch on "read"/"edit"/"terminal" by exact string, inherited from the
 * old (deleted) orchestrator's own hand-rolled tool registration. The
 * controller instead hands the backing `Agent` a Mastra `Workspace`
 * (`electron/agent/workspace-factory.ts`'s `createDemioWorkspace`, wired in
 * via `AgentControllerConfig.workspace` in `electron/agent/controller.ts`),
 * which registers Mastra's generic Workspace tool set under
 * `mastra_workspace_*` names instead. Map the ones the renderer treats
 * specially back to their legacy short names so the compact Read/Edit/
 * Terminal cards and cluster summaries ("read 3 files", "ran 2 commands")
 * fire instead of falling through to the generic `<Tool>` card for every
 * single filesystem/shell call; the rest get a shorter display name too,
 * though they only ever render through the generic card either way (only
 * "read"/"edit"/"terminal" get bespoke treatment in tool-usage.tsx).
 *
 * `present_files` and `ask_user`/`submit_plan`/`task_*` are NOT remapped —
 * those are registered under their own short names already (present_files:
 * the top-level `tools` callback in controller.ts, available in every mode,
 * including execute mode where the instructions explicitly call it after
 * `generate_demo`; ask_user/submit_plan/task_*: Mastra's built-in tools,
 * which already use short names).
 */
export const WORKSPACE_TOOL_NAME_MAP: Record<string, string> = {
  mastra_workspace_read_file: "read",
  mastra_workspace_edit_file: "edit",
  mastra_workspace_write_file: "write",
  mastra_workspace_execute_command: "terminal",
  mastra_workspace_grep: "grep",
  mastra_workspace_list_files: "list_files",
  mastra_workspace_mkdir: "mkdir",
  mastra_workspace_delete: "delete",
  mastra_workspace_file_stat: "file_stat",
  mastra_workspace_search: "search",
}

/**
 * `mastra_workspace_read_file`/`edit_file`/`write_file` take `{path, ...}`
 * (`node_modules/@mastra/core/dist/workspace/tools/{read,edit,write}-file.d.ts`);
 * the legacy compact Read/Edit rows this maps onto
 * (`ReadToolRow`/`EditToolRow` in tool-usage.tsx) read `input.filePath`.
 * Alias it onto the mapped input rather than editing that renderer (out of
 * this task's file list) — otherwise the cards fire (right icon, right
 * clustering) but show an empty "filesystem"/"file" fallback subtitle
 * instead of the real path.
 */
function withLegacyFilePathAlias(
  legacyToolName: string,
  input: unknown
): unknown {
  if (
    legacyToolName !== "read" &&
    legacyToolName !== "edit" &&
    legacyToolName !== "write"
  ) {
    return input
  }
  if (typeof input !== "object" || input === null) return input
  const path = (input as { path?: unknown }).path
  if (typeof path !== "string") return input
  return { ...input, filePath: path }
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
    const toolName = WORKSPACE_TOOL_NAME_MAP[inv.toolName] ?? inv.toolName
    const isResultError = inv.state === "result" && inv.isError === true
    // Double cast: the v4 `toolInvocation` fields don't structurally satisfy
    // v5's per-state discriminated `DynamicToolUIPart` union (e.g. `output`
    // typed `never` while `state` is `"input-streaming"`). This data only
    // ever flows into read-only rendering, never back through a provider
    // API, so trusting the runtime shape here is safe.
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId: inv.toolCallId,
      state: mapToolState(inv.state, inv.isError),
      input: withLegacyFilePathAlias(toolName, inv.args),
      output: inv.result,
      errorText: isResultError
        ? (inv.errorText ?? errorTextFromResult(inv.result))
        : inv.errorText,
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
  /** `generate_demo` stage tracker (Task 13) — see `WorkflowState`'s doc
   * comment for lifecycle (survives `agent_end`, cleared on thread switch or
   * a fresh `generate_demo` call). */
  workflow: WorkflowState | null

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

  const controllerMessages = useMemo(
    () =>
      agentEvents.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map(toUIMessage),
    [agentEvents.messages]
  )

  // ── Legacy JSON-store fallback (ADR-007: legacy threads stay readable) ──
  //
  // The controller's LibSQLStore has no history for a thread that predates
  // it — `agent.listMessages` (folded into `agentEvents.messages` by
  // `useAgentEvents`) resolves to zero messages for those threads, and
  // stays at zero forever (nothing in the controller pipeline ever touches
  // that thread id, so no live event populates it either). Fetch the old
  // JSON-store's messages in parallel and fall back to them — read-only,
  // no live updates — whenever the controller has nothing to show. They're
  // already `UIMessage`-shaped (the pre-controller pipeline persisted them
  // in exactly this ai-sdk v6 format via `apis.store.appendMessage`), so no
  // adapter is needed, unlike `controllerMessages` above. A thread with any
  // controller-era message history switches to (and stays on) the
  // controller's own messages once hydration resolves.
  // No explicit "reset to []" branch for the `!threadId` case: both routes
  // that render `ActiveThreadProvider` key it by `${projectId}:${threadId}`
  // (`src/pages/projects/projectId/{index,thread/index}.tsx`), so a threadId
  // change always remounts this component fresh (initial state `[]`) rather
  // than re-running this effect with a new `threadId` prop on the same
  // instance — there's no live case where a stale non-empty array would
  // leak across threads. (Calling `setState` synchronously in an effect body
  // to cover a case that structurally can't occur trips this repo's
  // `react-hooks/set-state-in-effect` lint rule for no real benefit.)
  const [legacyMessages, setLegacyMessages] = useState<UIMessage[]>([])
  useEffect(() => {
    if (!apis || !threadId) return
    let cancelled = false
    void apis.store.getMessages(projectId, threadId).then((msgs) => {
      if (!cancelled) setLegacyMessages(msgs)
    })
    return () => {
      cancelled = true
    }
  }, [projectId, threadId])

  const messages =
    controllerMessages.length > 0 ? controllerMessages : legacyMessages

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

  // Dismissing the error clears the banner (`error` above) but must also
  // stop the prompt-input submit button (thread-shell.tsx's `chatStatus`)
  // from staying error-styled — otherwise dismiss only removes the banner
  // text while the button still looks broken. Only overridden while the run
  // is still resting on the SAME dismissed error: a genuinely new run starts
  // with `agent_start` (status "running"), and any new error resets
  // `dismissedError` via the `lastSeenError` comparison above, so this can't
  // mask real, current error state.
  const status: ThreadStatus =
    dismissedError && agentEvents.status === "error"
      ? "idle"
      : agentEvents.status

  const value = useMemo<ActiveThreadContextValue>(
    () => ({
      projectId,
      threadId,
      project,
      thread,
      threads,
      messages,
      status,
      error,
      suspension: agentEvents.suspension,
      workflow: agentEvents.workflow,
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
      status,
      agentEvents.suspension,
      agentEvents.workflow,
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
