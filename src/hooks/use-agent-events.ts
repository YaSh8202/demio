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
 * thread_*, tool_start/update/end, om_*, subagent_*, task_updated, ...) are
 * intentionally not modeled here; they fall through the reducer's default
 * case and are ignored without crashing, per the brief. */
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

export interface AgentEventState {
  messages: SerializedAgentMessage[]
  status: "idle" | "running" | "error"
  error: AgentEventError | null
  suspension: AgentSuspension | null
  displayState: SerializedDisplayState | null
  shellOutput: Record<string, string>
  usage: TokenUsage | null
}

const initial: AgentEventState = {
  messages: [],
  status: "idle",
  error: null,
  suspension: null,
  displayState: null,
  shellOutput: {},
  usage: null,
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

function reducer(
  state: AgentEventState,
  event: ControllerEvent
): AgentEventState {
  switch (event.type) {
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

    default:
      // Unknown/unmodeled event types (mode_changed, thread_*, tool_start,
      // om_*, subagent_*, task_updated, ...) are intentionally no-ops.
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
    if (!threadId || !apis || !events) return
    const key = `${projectId}:${threadId}`

    // Subscribe first — nothing landing between the subscription and the
    // hydration calls below is lost, and replay is safe (message dedupe by
    // id, display_state_changed is an authoritative snapshot either way).
    const unsub = events.agent.onEvent((evtKey: string, event: unknown) => {
      if (evtKey !== key) return
      dispatch(event as ControllerEvent)
    })

    apis.agent
      .listMessages(projectId, threadId)
      .then((messages) => {
        for (const message of messages as SerializedAgentMessage[]) {
          dispatch({ type: "message_update", message })
        }
      })
      .catch(() => {})

    // Belt and braces: main also broadcasts a synthetic display_state_changed
    // on subscribe attach (first-mount resync), so this is usually
    // redundant — but idempotent, and covers the case where subscribe
    // resolves after this call already landed.
    apis.agent
      .getDisplayState(projectId, threadId)
      .then((displayState) => {
        if (displayState) {
          dispatch({
            type: "display_state_changed",
            displayState: displayState as SerializedDisplayState,
          })
        }
      })
      .catch(() => {})

    return unsub
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
