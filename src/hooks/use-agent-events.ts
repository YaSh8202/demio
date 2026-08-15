// ── useAgentEvents ───────────────────────────────────────────────────────────
//
// Consumes AgentController events broadcast over IPC (`events.agent.onEvent`,
// keyed by `${projectId}:${threadId}`) and folds them into renderable thread
// state. Replaces the SSE-chunk + useChat pipeline for the thread view.
// Re-hydrates via `agent.listMessages` + `agent.getDisplayState` on mount so
// a refreshed window resumes mid-run — main also broadcasts a synthetic
// `display_state_changed` resync on subscribe, so both paths race harmlessly
// (idempotent, dedupe-by-id for messages / authoritative-snapshot for
// display state).
//
// Event shapes: `node_modules/@mastra/core/dist/agent-controller/types.d.ts`
// (`AgentControllerEvent` union, `AgentControllerDisplayState`). Everything
// crossing the IPC boundary has already been through `serializeEvent` in
// `electron/handlers/agent.ts`: Maps -> plain objects, Errors -> {name,
// message, stack}, Dates -> ISO strings.

import { useCallback, useEffect, useReducer } from "react"
import { apis, events } from "@/types/electron-api"
import log from "@/lib/logger"
import type { UIMessage } from "../../electron/store/types"
import type {
  MastraDBMessage,
  ActiveToolState,
  ActiveSubagentState,
  TokenUsage,
  AgentControllerDisplayState,
} from "@mastra/core/agent-controller"
import type { SubmitPlanSuspendPayload } from "@mastra/core/tools"

// `TaskItemSnapshot` (task_write/task_update built-in tool state) isn't
// re-exported from the `@mastra/core/agent-controller` public entrypoint
// (only from the internal `agent-controller/tools.js`) — pull the element
// type off `AgentControllerDisplayState.tasks` instead of reaching into an
// unexported subpath.
type TaskItemSnapshot = AgentControllerDisplayState["tasks"][number]

// ── Serialized shapes ───────────────────────────────────────────────────────
//
// `serializeEvent` (electron/handlers/agent.ts) round-trips every event
// through `JSON.stringify`/`JSON.parse` with a replacer that turns `Map` into
// a plain object and `Error` into `{name, message, stack}` — so the shapes
// below diverge from the `.d.ts` types (`Map<K, V>` -> `Record<string, V>`,
// `Date` -> `string`) even though the field names line up 1:1.

/** `MastraDBMessage` as it arrives over IPC (`createdAt` is an ISO string, not a `Date`). */
export type SerializedAgentMessage = Omit<MastraDBMessage, "createdAt"> & {
  createdAt: string
}

/** A `pendingSuspensions` entry, plus the `planContent` sibling field
 * `attachPlanContent` (electron/handlers/agent.ts) adds for `submit_plan`. */
export interface SerializedPendingSuspension {
  toolCallId: string
  toolName: string
  args: unknown
  suspendPayload: unknown
  resumeSchema?: string
  planContent?: string
}

type SerializedModifiedFile = { operations: string[]; firstModified: string }
type SerializedToolInputBuffer = { text: string; toolName: string }

/** `AgentControllerDisplayState` as it arrives over IPC. */
export type SerializedDisplayState = Omit<
  AgentControllerDisplayState,
  | "currentMessage"
  | "activeTools"
  | "toolInputBuffers"
  | "pendingSuspensions"
  | "activeSubagents"
  | "modifiedFiles"
> & {
  currentMessage: SerializedAgentMessage | null
  activeTools: Record<string, ActiveToolState>
  toolInputBuffers: Record<string, SerializedToolInputBuffer>
  pendingSuspensions: Record<string, SerializedPendingSuspension>
  activeSubagents: Record<string, ActiveSubagentState>
  modifiedFiles: Record<string, SerializedModifiedFile>
  tasks: TaskItemSnapshot[]
  previousTasks: TaskItemSnapshot[]
}

/** Serialized controller `error` event payload — `Error` reduced to `{name, message, stack}`. */
interface SerializedError {
  name: string
  message: string
  stack?: string
}

/** Discriminated union of the controller event shapes this hook acts on.
 * `AgentControllerEvent` (types.d.ts) has ~40 variants — most (mode_changed,
 * thread_*, tool_start/end, om_*, subagent_*, task_updated, ...) are
 * intentionally not modeled here; they fall through the reducer's default
 * case and are ignored without crashing, per the brief. `tool_update` IS
 * modeled (Task 13) — but only its `scene-progress` shaped partialResult is
 * acted on, everything else routes to the reducer's default case too. */
type ControllerEvent =
  | { type: "agent_start" }
  | {
      type: "agent_end"
      reason?: "complete" | "aborted" | "error" | "suspended"
    }
  | { type: "message_start"; message: SerializedAgentMessage }
  | { type: "message_update"; message: SerializedAgentMessage }
  | { type: "message_end"; message: SerializedAgentMessage }
  | {
      type: "tool_suspended"
      toolCallId: string
      toolName: string
      args: unknown
      suspendPayload: unknown
      resumeSchema?: string
      planContent?: string
    }
  | {
      type: "tool_suspension_cancelled"
      toolCallId: string
      toolName: string
      reason: string
    }
  | { type: "tool_approval_required"; toolCallId: string; toolName: string }
  | { type: "display_state_changed"; displayState: SerializedDisplayState }
  | { type: "error"; error: SerializedError }
  | { type: "usage_update"; usage: TokenUsage }
  | {
      type: "shell_output"
      toolCallId: string
      output: string
      stream: "stdout" | "stderr"
    }
  | { type: "mode_changed"; modeId: string; previousModeId: string }
  | { type: "model_changed"; modelId: string }
  // `AgentControllerEvent`'s `tool_update` variant (types.d.ts:609-613):
  // `{type, toolCallId, partialResult}` — no `toolName` field (confirmed
  // against the compiled source, agent-controller-ByW51eCC.js ~line 831),
  // so `generate_demo`'s scene-progress writes can only be recognized by
  // `partialResult.type === "scene-progress"` below, never by tool name.
  | { type: "tool_update"; toolCallId: string; partialResult: unknown }

/** Internal reducer actions beyond the raw controller event union — never
 * broadcast over IPC, only dispatched locally by the effect below. */
type HookAction =
  | ControllerEvent
  // Fired at the start of every (projectId, threadId)-keyed effect run so
  // switching threads doesn't leak the previous thread's messages,
  // suspension, displayState, usage, or shellOutput into the new one.
  | { type: "reset" }
  // `listMessages` hydration result, one dispatch per message. Distinct
  // from `message_update` so hydration can never clobber a live-streamed
  // message that already landed (insert-only-if-absent — see
  // `insertIfAbsent`), whereas a live `message_update` always replaces.
  | { type: "hydrate_message"; message: SerializedAgentMessage }
  // `listMessages`/`getDisplayState` hydration rejected. Surfaced the same
  // way a live controller `error` event is, so a broken IPC call on mount
  // doesn't silently present as an empty idle thread.
  | { type: "hydrate_error"; error: AgentEventError }
  // Local echo of an outgoing user message, dispatched by `send()` so the
  // prompt is visible the instant it's sent. The controller DOES broadcast
  // the prompt back once persisted (as a `role: "signal"` message — see
  // `isUserSignal`), but only after the signal is accepted, and never if the
  // send fails outright; the echo covers that window. `reconcileEcho` drops
  // it again when the persisted counterpart lands, live or on hydration.
  | { type: "local_user_message"; message: SerializedAgentMessage }

// ── Public state shape (Task 6 relies on these field names exactly) ────────

export interface AgentSuspension {
  toolCallId: string
  toolName: string
  payload: unknown
}

export interface AgentEventError {
  name: string
  message: string
}

/** One scene's progress, as last reported by `generate_demo`'s
 * `record-scene` step (`electron/agent/workflows/record-scene.ts`'s
 * `onProgress` callback, forwarded verbatim through the `scene-progress`
 * `tool_update` payload). */
export interface WorkflowSceneState {
  phase: "recording" | "verifying" | "failed" | "done"
  attempt: number
  detail?: string
}

/** Fold of every `scene-progress` update seen for ONE `generate_demo` tool
 * call. Keyed by `toolCallId` in `AgentEventState.workflows`, so a thread
 * with several `generate_demo` calls (e.g. a retry after a failed run) keeps
 * each card's scene states separate instead of the newest call clobbering
 * the older one's. Deliberately NOT cleared on `agent_end` — see
 * `AgentEventState.workflows`' own doc comment. */
export interface WorkflowState {
  toolCallId: string
  of: number
  scenes: Record<string, WorkflowSceneState>
}

/** Shape of `generate_demo`'s `scene-progress` `tool_update` partialResult
 * (`electron/agent/workflows/demo-video.ts`'s `sceneStep`:
 * `writer.write({type: "scene-progress", ...u, of: scenes.length})`, `u`
 * being `record-scene.ts`'s `onProgress` payload). */
interface SceneProgressPartialResult {
  type: "scene-progress"
  sceneId: string
  attempt: number
  phase: WorkflowSceneState["phase"]
  of: number
  detail?: string
}

function isSceneProgress(value: unknown): value is SceneProgressPartialResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "scene-progress" &&
    typeof (value as { sceneId?: unknown }).sceneId === "string"
  )
}

/** A `scene-progress` update, from either carrier (live `tool_update` event
 * or a persisted `data-mastracode-tool-progress` message part), folded into
 * the per-call `workflows` map. Last write wins — matching the live event
 * semantics, and correct for the persisted parts too since they're stored in
 * chronological order. */
function foldSceneProgress(
  workflows: Record<string, WorkflowState>,
  toolCallId: string,
  p: SceneProgressPartialResult
): Record<string, WorkflowState> {
  const prev = workflows[toolCallId]
  return {
    ...workflows,
    [toolCallId]: {
      toolCallId,
      of: p.of,
      scenes: {
        ...(prev?.scenes ?? {}),
        [p.sceneId]: { phase: p.phase, attempt: p.attempt, detail: p.detail },
      },
    },
  }
}

/** The persisted counterpart of a `scene-progress` `tool_update`: the same
 * payload also lands on the assistant message as a
 * `data-mastracode-tool-progress` part (written by `outputWriter` in
 * `electron/agent/controller.ts`, persisted through the agent's Memory).
 * `use-active-thread.tsx`'s `mapPart` drops every `data-*` part for
 * RENDERING — correctly, there's no renderer for them — but this reads the
 * raw message before that mapping, which is what lets a refreshed thread
 * show each scene's last-known phase instead of resetting to "Queued". */
interface ToolProgressPart {
  type: "data-mastracode-tool-progress"
  data: { toolCallId?: unknown; progress?: unknown }
}

function isToolProgressPart(part: unknown): part is ToolProgressPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "data-mastracode-tool-progress" &&
    typeof (part as { data?: unknown }).data === "object" &&
    (part as { data: unknown }).data !== null
  )
}

/** Fold every `scene-progress` carried by a message's persisted parts.
 * Idempotent (pure last-write-wins over an ordered part list), so calling it
 * for a message that was already folded — a `message_update` re-emitting the
 * whole message, or a `hydrate_message` that `insertIfAbsent` skips — is
 * harmless. Returns the same object identity when nothing was folded. */
function foldProgressParts(
  workflows: Record<string, WorkflowState>,
  message: SerializedAgentMessage
): Record<string, WorkflowState> {
  let next = workflows
  for (const part of message.content?.parts ?? []) {
    if (!isToolProgressPart(part)) continue
    const { toolCallId, progress } = part.data
    if (typeof toolCallId !== "string" || !isSceneProgress(progress)) continue
    next = foldSceneProgress(next, toolCallId, progress)
  }
  return next
}

export interface AgentEventState {
  messages: SerializedAgentMessage[]
  status: "idle" | "running" | "error"
  error: AgentEventError | null
  suspension: AgentSuspension | null
  displayState: SerializedDisplayState | null
  shellOutput: Record<string, string>
  usage: TokenUsage | null
  /** `generate_demo` stage trackers keyed by `toolCallId` (see
   * `WorkflowState`), folded from both carriers of `scene-progress`: live
   * `tool_update` events and the persisted `data-mastracode-tool-progress`
   * parts replayed on hydration. Empty until the first of either. Entries
   * deliberately survive `agent_end` (a finished/suspended run's last-known
   * scene states stay visible in the card rather than disappearing the
   * instant the run stops) — only `reset` (thread switch) clears them. */
  workflows: Record<string, WorkflowState>
  /** Ids of optimistically-echoed user messages (`local_user_message`) that
   * haven't yet been reconciled against their persisted counterpart. See
   * `reconcileEcho`. */
  pendingEchoIds: string[]
}

const initial: AgentEventState = {
  messages: [],
  status: "idle",
  error: null,
  suspension: null,
  displayState: null,
  shellOutput: {},
  usage: null,
  workflows: {},
  pendingEchoIds: [],
}

// Cap accumulated shell output per toolCallId — a long-running command's
// stdout must not grow the reducer state unboundedly.
const MAX_SHELL_OUTPUT_BYTES = 200 * 1024

/** Build the `suspension.payload` for a pending suspension entry, merging in
 * `planContent` as a sibling field when present (submit_plan only) — the
 * only carrier `AgentEventState.suspension` exposes for it. */
function buildSuspensionPayload(
  suspendPayload: unknown,
  planContent: string | undefined
): unknown {
  if (planContent === undefined) return suspendPayload
  if (typeof suspendPayload !== "object" || suspendPayload === null) {
    return { planContent }
  }
  return { ...suspendPayload, planContent }
}

/** Pick which `pendingSuspensions` entry becomes the single `suspension`
 * surfaced to Task 6 UI: prefer one carrying `planContent` (submit_plan,
 * explicitly called out by the brief as the entry that "wins"), else the
 * first entry in Map/object insertion order. `null` when the map is empty —
 * `display_state_changed` is authoritative for this per the brief. */
function pickSuspension(
  pendingSuspensions: Record<string, SerializedPendingSuspension>
): AgentSuspension | null {
  const entries = Object.values(pendingSuspensions)
  if (entries.length === 0) return null
  const chosen = entries.find((e) => e.planContent !== undefined) ?? entries[0]
  return {
    toolCallId: chosen.toolCallId,
    toolName: chosen.toolName,
    payload: buildSuspensionPayload(chosen.suspendPayload, chosen.planContent),
  }
}

function upsertMessage(
  messages: SerializedAgentMessage[],
  message: SerializedAgentMessage
): SerializedAgentMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id)
  if (idx === -1) return [...messages, message]
  const next = messages.slice()
  next[idx] = message
  return next
}

/** Insert a hydrated (`listMessages`) message only if no message with that
 * id is already present — a `listMessages` snapshot is a point-in-time read
 * that can resolve after live `message_update` events for the same id have
 * already streamed in newer content; hydration must never regress that. */
function insertIfAbsent(
  messages: SerializedAgentMessage[],
  message: SerializedAgentMessage
): SerializedAgentMessage[] {
  return messages.some((m) => m.id === message.id)
    ? messages
    : [...messages, message]
}

/** Mastra persists demio's user prompts as `role: "signal"` messages, never
 * as `role: "user"`: `session.sendMessage` (electron/handlers/agent.ts)
 * routes the text through the signal pipeline, which stores it with
 * `content.metadata.signal = {type: "user", tagName: "user"}`. Mirrors
 * Mastra's own `isUserSignalType`
 * (node_modules/@mastra/core/dist/message-list-D-0IY45i.js:570), whose
 * converter maps exactly these to `role: "user"` and every other signal
 * (system reminders, state, reactive, notification — all control plane) to
 * `"system"`. Not re-exported from `@mastra/core`, hence the local copy. */
export function isUserSignal(message: SerializedAgentMessage): boolean {
  if (message.role !== "signal") return false
  const signal = (
    message.content as {
      metadata?: { signal?: { type?: string } }
    }
  ).metadata?.signal
  return signal?.type === "user" || signal?.type === "user-message"
}

/** Concatenated text of a message's text parts, trimmed — the only field an
 * echo and its persisted counterpart share (the ids never match). */
function messageText(message: SerializedAgentMessage): string {
  return (message.content?.parts ?? [])
    .map((p) =>
      (p as { type?: string; text?: string }).type === "text"
        ? ((p as { text?: string }).text ?? "")
        : ""
    )
    .join("")
    .trim()
}

/** Drop the optimistic echo a just-arrived persisted user message supersedes.
 *
 * `send()` echoes the outgoing prompt locally under a client-generated id so
 * it's visible immediately. The controller then broadcasts the SAME prompt
 * back as a persisted `role: "signal"` message (`data-user-message` ->
 * `createSignalMessage` -> `message_start`/`message_end`) under a
 * Mastra-generated id, and hydration replays it on the next mount. Since the
 * ids can never match, upserting the real message without this would render
 * the prompt twice for the rest of the live session.
 *
 * Matched on trimmed text against the oldest un-reconciled echo — ids are
 * unusable and demio sends one prompt at a time. No-op (same state identity)
 * when the message isn't a user signal or nothing matches. */
function reconcileEcho(
  state: AgentEventState,
  message: SerializedAgentMessage
): AgentEventState {
  if (state.pendingEchoIds.length === 0 || !isUserSignal(message)) return state
  const text = messageText(message)
  const echoId = state.pendingEchoIds.find((id) => {
    const echo = state.messages.find((m) => m.id === id)
    return echo !== undefined && messageText(echo) === text
  })
  if (echoId === undefined) return state
  return {
    ...state,
    messages: state.messages.filter((m) => m.id !== echoId),
    pendingEchoIds: state.pendingEchoIds.filter((id) => id !== echoId),
  }
}

function appendShellOutput(
  shellOutput: Record<string, string>,
  toolCallId: string,
  chunk: string
): Record<string, string> {
  const combined = (shellOutput[toolCallId] ?? "") + chunk
  const capped =
    combined.length > MAX_SHELL_OUTPUT_BYTES
      ? combined.slice(combined.length - MAX_SHELL_OUTPUT_BYTES)
      : combined
  return { ...shellOutput, [toolCallId]: capped }
}

function reducer(state: AgentEventState, event: HookAction): AgentEventState {
  switch (event.type) {
    case "reset":
      return initial

    case "hydrate_message": {
      const base = reconcileEcho(state, event.message)
      return {
        ...base,
        messages: insertIfAbsent(base.messages, event.message),
        workflows: foldProgressParts(base.workflows, event.message),
      }
    }

    case "local_user_message":
      return {
        ...state,
        messages: upsertMessage(state.messages, event.message),
        pendingEchoIds: [...state.pendingEchoIds, event.message.id],
      }

    case "hydrate_error":
      return { ...state, status: "error", error: event.error }

    case "agent_start":
      return { ...state, status: "running", error: null }

    case "agent_end": {
      const status: AgentEventState["status"] =
        event.reason === "error" ? "error" : "idle"
      // Cleared unconditionally here; if the run actually ended because a
      // tool suspended, the display_state_changed that fans right after
      // (main broadcasts one after every event) still carries the pending
      // entry in pendingSuspensions and restores it — see pickSuspension.
      return { ...state, status, suspension: null }
    }

    case "message_start":
    case "message_update":
    case "message_end": {
      const base = reconcileEcho(state, event.message)
      return {
        ...base,
        messages: upsertMessage(base.messages, event.message),
        // Belt and braces alongside the `tool_update` case below: the same
        // scene-progress payloads ride along on the assistant message's
        // parts, so folding here keeps the card correct even if a
        // `tool_update` event is ever dropped.
        workflows: foldProgressParts(base.workflows, event.message),
      }
    }

    case "tool_suspended":
      return {
        ...state,
        suspension: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          payload: buildSuspensionPayload(
            event.suspendPayload,
            event.planContent
          ),
        },
      }

    case "tool_suspension_cancelled":
      return state.suspension?.toolCallId === event.toolCallId
        ? { ...state, suspension: null }
        : state

    case "display_state_changed": {
      const ds = event.displayState
      // isRunning is authoritative for run-state, but must not clobber an
      // "error" status set by a prior `error` event — that event and the
      // resync it triggers can interleave with a still-in-flight abort.
      const status: AgentEventState["status"] =
        state.status === "error" ? "error" : ds.isRunning ? "running" : "idle"
      return {
        ...state,
        displayState: ds,
        status,
        suspension: pickSuspension(ds.pendingSuspensions),
        usage: ds.tokenUsage ?? state.usage,
      }
    }

    case "error":
      return {
        ...state,
        status: "error",
        error: { name: event.error.name, message: event.error.message },
      }

    // Safety net: demio runs with session-wide yolo (auto-approve), so this
    // should never fire. If a future policy change re-enables approval gates
    // without shipping an approval UI, surface a visible error instead of the
    // run silently hanging on an unanswerable gate.
    case "tool_approval_required":
      return {
        ...state,
        status: "error",
        error: {
          name: "ToolApprovalRequired",
          message:
            "A tool call is waiting for approval, but demio has no approval UI. " +
            "This is a configuration bug (yolo should be enabled) — cancel the run and report it.",
        },
      }

    case "usage_update":
      return { ...state, usage: event.usage }

    case "shell_output":
      return {
        ...state,
        shellOutput: appendShellOutput(
          state.shellOutput,
          event.toolCallId,
          event.output
        ),
      }

    case "tool_update": {
      if (!isSceneProgress(event.partialResult)) return state
      return {
        ...state,
        workflows: foldSceneProgress(
          state.workflows,
          event.toolCallId,
          event.partialResult
        ),
      }
    }

    default:
      // Unknown/unmodeled event types (mode_changed, thread_*, tool_start,
      // tool_end, om_*, subagent_*, task_updated, ...) are intentionally
      // no-ops — including a `tool_update` whose `partialResult` isn't
      // `scene-progress` shaped (returned early inside the `tool_update`
      // case above, never reaching here, but noted for completeness).
      return state
  }
}

export function useAgentEvents(
  projectId: string,
  threadId: string | null
): AgentEventState & {
  send: (text: string) => Promise<void>
  respond: (toolCallId: string, resumeData: unknown) => Promise<void>
  cancel: () => Promise<void>
} {
  const [state, dispatch] = useReducer(reducer, initial)

  useEffect(() => {
    // Every (projectId, threadId) change starts from a clean slate — without
    // this, switching threads appends the new thread's hydrated messages
    // onto the previous thread's `messages` array (upsert-by-id never
    // collides across threads), and `suspension`/`displayState`/`usage`/
    // `shellOutput` all carry over too.
    dispatch({ type: "reset" })

    if (!threadId || !apis || !events) return
    const key = `${projectId}:${threadId}`

    // Guards the hydration .then()/.catch() bodies below (and the live
    // listener above the `cancelled` check wouldn't help, so it's unsub'd
    // instead): an in-flight `listMessages`/`getDisplayState` call started
    // for thread A must not dispatch into thread B's state if the effect
    // re-ran (thread switch) before that promise settled. Set in cleanup.
    let cancelled = false

    // Subscribe first — nothing landing between the subscription and the
    // hydration calls below is lost, and replay is safe (message dedupe by
    // id, display_state_changed is an authoritative snapshot either way).
    const unsub = events.agent.onEvent((evtKey: string, event: unknown) => {
      if (evtKey !== key) return
      dispatch(event as ControllerEvent)
    })

    async function hydrate() {
      try {
        // Sequential, per spec: listMessages before getDisplayState.
        const messages = await apis!.agent.listMessages(projectId, threadId!)
        if (cancelled) return
        for (const message of messages as SerializedAgentMessage[]) {
          dispatch({ type: "hydrate_message", message })
        }

        // Belt and braces: main also broadcasts a synthetic
        // display_state_changed on subscribe attach (first-mount resync),
        // so this is usually redundant — but idempotent, and covers the
        // case where subscribe resolves after this call already landed.
        const displayState = await apis!.agent.getDisplayState(
          projectId,
          threadId!
        )
        if (cancelled) return
        if (displayState) {
          dispatch({
            type: "display_state_changed",
            displayState: displayState as SerializedDisplayState,
          })
        }
      } catch (error) {
        if (cancelled) return
        log.error("[useAgentEvents] hydration failed:", error)
        dispatch({
          type: "hydrate_error",
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "Error", message: String(error) },
        })
      }
    }

    void hydrate()

    return () => {
      cancelled = true
      unsub()
    }
  }, [projectId, threadId])

  const send = useCallback(
    async (text: string) => {
      if (!threadId || !apis) return
      const message: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
      }
      // Echo locally BEFORE the IPC call — see `local_user_message`'s doc
      // comment. Cast: `MastraMessagePart` is a broad union; this literal
      // text part matches its v4 text-part member at runtime.
      dispatch({
        type: "local_user_message",
        message: {
          id: message.id,
          role: "user",
          threadId,
          createdAt: new Date().toISOString(),
          content: {
            format: 2,
            parts: [{ type: "text", text }],
            content: text,
          },
        } as SerializedAgentMessage,
      })
      await apis.agent.sendMessage(projectId, threadId, { message })
    },
    [projectId, threadId]
  )

  const respond = useCallback(
    async (toolCallId: string, resumeData: unknown) => {
      if (!threadId || !apis) return
      await apis.agent.respondSuspension(projectId, threadId, {
        toolCallId,
        resumeData,
      })
    },
    [projectId, threadId]
  )

  const cancel = useCallback(async () => {
    if (!threadId || !apis) return
    await apis.agent.cancel(projectId, threadId)
  }, [projectId, threadId])

  return { ...state, send, respond, cancel }
}

// Re-exported for consumers that need to interpret submit_plan's suspend
// payload shape after `buildSuspensionPayload` merges in `planContent`.
export type { SubmitPlanSuspendPayload }
