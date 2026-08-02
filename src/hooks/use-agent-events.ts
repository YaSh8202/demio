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

/** Fold of every `scene-progress` `tool_update` seen for the current (or
 * most recent) `generate_demo` tool call. `toolCallId` scopes `scenes` to a
 * single call — a later call (e.g. a fresh `generate_demo` after a prior
 * run finished) starts its `scenes` map over rather than merging onto a
 * stale one. Deliberately NOT cleared on `agent_end`/`reset` of the run
 * status alone — see `AgentEventState.workflow`'s own doc comment. */
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

export interface AgentEventState {
  messages: SerializedAgentMessage[]
  status: "idle" | "running" | "error"
  error: AgentEventError | null
  suspension: AgentSuspension | null
  displayState: SerializedDisplayState | null
  shellOutput: Record<string, string>
  usage: TokenUsage | null
  /** `generate_demo` stage tracker, folded from `scene-progress` `tool_update`
   * events (see `WorkflowState`). `null` until the first such event for the
   * current/most-recent thread. Deliberately survives `agent_end` (a
   * finished/suspended run's last-known scene states stay visible in the
   * card rather than disappearing the instant the run stops) — only
   * `reset` (thread switch) or a fresh `generate_demo` call under a new
   * `toolCallId` clears/replaces it. */
  workflow: WorkflowState | null
}

const initial: AgentEventState = {
  messages: [],
  status: "idle",
  error: null,
  suspension: null,
  displayState: null,
  shellOutput: {},
  usage: null,
  workflow: null,
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

    case "hydrate_message":
      return {
        ...state,
        messages: insertIfAbsent(state.messages, event.message),
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
    case "message_end":
      return {
        ...state,
        messages: upsertMessage(state.messages, event.message),
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
      const p = event.partialResult
      // A new `toolCallId` (a fresh `generate_demo` call) starts `scenes`
      // over instead of merging onto whatever the previous call left behind.
      const prevScenes =
        state.workflow?.toolCallId === event.toolCallId
          ? state.workflow.scenes
          : {}
      return {
        ...state,
        workflow: {
          toolCallId: event.toolCallId,
          of: p.of,
          scenes: {
            ...prevScenes,
            [p.sceneId]: { phase: p.phase, attempt: p.attempt, detail: p.detail },
          },
        },
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
