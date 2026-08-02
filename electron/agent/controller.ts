// ── AgentController runtime ──────────────────────────────────────────────────
//
// Singleton Mastra AgentController owning demio's conversation layer:
// per-thread sessions, plan/execute modes, built-in ask_user + submit_plan,
// Workspace-provided core tools, and the event stream the IPC handler
// broadcasts to the renderer.
//
// Replaces the hand-rolled sessions.ts (AbortController map), runs.ts (SSE
// replay buffer) and questions.ts (deferred-promise ask_user).
//
// Reconciled against the installed @mastra/core@1.55.0 .d.ts — see
// task-3-report.md for the full deviation list. The two load-bearing ones:
//
//   1. `AgentControllerConfig` has NO `resolveModel` field (the brief's
//      code invents one). Model resolution instead goes through a backing
//      `Agent` — `AgentControllerConfig.agent` — whose own `model` field
//      accepts `DynamicArgument<MastraModelConfig>`, i.e. a function of
//      `{ requestContext }` returning a LanguageModel. When `config.agent`
//      is set, `getAgentForMode()` returns it directly for every mode
//      (`agent-controller.d.ts` compiled source, `getAgentForMode`), so this
//      is the correct place to plug `getModel()` back in per-session.
//
//   2. Workspace tool names are NOT the short guesses in the brief
//      ("read", "grep", "glob"). Verified at runtime via
//      `createWorkspaceTools()` (see workspace-factory.ts comment / report):
//      `mastra_workspace_read_file`, `mastra_workspace_write_file`,
//      `mastra_workspace_edit_file`, `mastra_workspace_list_files`,
//      `mastra_workspace_grep`, `mastra_workspace_mkdir`,
//      `mastra_workspace_execute_command`, etc. Plan mode's `availableTools`
//      below also adds write_file/edit_file/mkdir beyond the brief's
//      read-only list — the plan-mode instructions require writing (and
//      revising) the plan markdown file under `plans/`, which is impossible
//      with a read-only allowlist.

import { AgentController } from "@mastra/core/agent-controller"
import type {
  AgentControllerEvent,
  AgentControllerRequestContext,
  Session,
} from "@mastra/core/agent-controller"
import { Agent } from "@mastra/core/agent"
import type { ToolsInput } from "@mastra/core/agent"
import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { getModel } from "./providers"
import { DEFAULT_MODEL_ID } from "./types"
import { chatInstructions } from "./prompts"
import { createDemioWorkspace } from "./workspace-factory"
import { createPresentFilesTool } from "./tools/present-files"
import { ensureWorkspace } from "./workspace"
import { scenePlanSchema } from "./workflows/schemas"
import { mastra, mastraStore } from "./mastra"
import { getProject } from "../store"
import log from "../lib/logger"

/** Re-exported for the IPC handler/preload typing (Task 4). */
export type DemioControllerEvent = AgentControllerEvent

const stateSchema = z.object({
  currentModelId: z.string().optional(),
  // Session-wide tool auto-approval. The controller's approval resolution
  // falls back to "ask" for every tool when no yolo/policy/category matches
  // (resolveToolApproval in @mastra/core agent-controller), which parks the
  // run on a tool_approval_required gate demio has no UI for — the very first
  // tool call would hang forever. Local single-user app: default allow, same
  // as MastraCode's shipped default. Revisit when an approval UI lands.
  yolo: z.boolean().optional(),
  activePlan: z
    .object({
      title: z.string(),
      plan: z.string(),
      approvedAt: z.string(),
    })
    .optional(),
})

export type DemioControllerState = z.infer<typeof stateSchema>

/**
 * Plan mode's tool visibility allowlist (`availableTools`). Built-in
 * interaction/task tools (`ask_user`, `submit_plan`, `task_*`) use their
 * documented short names; workspace tools use the exposed names
 * `createWorkspaceTools()` actually registers in this @mastra/core version
 * (no short-name rewriting is applied — see file header).
 *
 * write_file/edit_file/mkdir are additions beyond the brief: plan mode's
 * instructions require writing the plan file under `plans/` and revising it
 * in place, which needs them.
 *
 * execute_command is also a required addition (found in review): plan
 * mode's own instructions say "explore the target site read-only if
 * needed" — that discovery happens via the `agent-browser` CLI, which only
 * exists as a PATH-shimmed binary the agent invokes through
 * mastra_workspace_execute_command. Without it in the allowlist plan mode
 * cannot do the discovery its instructions describe.
 */
const PLAN_MODE_TOOLS = [
  "mastra_workspace_read_file",
  "mastra_workspace_list_files",
  "mastra_workspace_grep",
  "mastra_workspace_write_file",
  "mastra_workspace_edit_file",
  "mastra_workspace_mkdir",
  "mastra_workspace_execute_command",
  "ask_user",
  "submit_plan",
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
]

/** Read the {controllerId, session, scope, threadId, ...} snapshot a dynamic config callback receives. */
function readControllerCtx(requestContext: {
  get: (key: string) => unknown
}): AgentControllerRequestContext<DemioControllerState> | undefined {
  return requestContext.get("controller") as
    | AgentControllerRequestContext<DemioControllerState>
    | undefined
}

/** Resolve the threadId a dynamic config callback is running for. Prefers `scope` (set to threadId by getOrCreateSession below) over the session id convention, per the brief's own fallback guidance. */
function threadIdFromCtx(
  ctx: AgentControllerRequestContext<DemioControllerState> | undefined
): string | undefined {
  return ctx?.scope ?? ctx?.threadId ?? undefined
}

// ── generate_demo tool (Task 12) ─────────────────────────────────────────────
//
// Runs the `demo-video` workflow (workflows/demo-video.ts) and streams its
// per-scene progress. Surfaces the workflow's own per-scene suspend/resume
// (retry/skip/abort a scene that exhausted its recording attempts) as a
// NATIVE tool suspension — `context.agent.suspend(...)` — rather than a
// custom controller event.
//
// Reconciliation evidence (brief proposed a custom `workflow_suspended`
// event + a new `agent.resumeWorkflow` handler "mirroring respondSuspension"
// IF the native route wasn't available):
//
// - `ToolExecutionContext.agent: AgentToolExecutionContext<TSuspend, TResume>`
//   (`node_modules/@mastra/core/dist/tools/types.d.ts:146-159`) is populated
//   with `{ suspend, resumeData, toolCallId, ... }` whenever a Mastra
//   `Tool` (via `createTool`) executes inside an Agent's tool-call loop —
//   confirmed in the compiled tool-call step
//   (`node_modules/@mastra/core/dist/agent-0y2cApTZ.js` ~line 27271: the
//   `toolOptions.suspend` passed to every tool call enqueues a
//   `tool-call-suspended` chunk and delegates to the step's own `suspend()`).
//   The AgentController's session machinery
//   (`node_modules/@mastra/core/dist/agent-controller-ByW51eCC.js` ~line 503)
//   converts that chunk into a `tool_suspended` AgentControllerEvent and
//   registers it in `session.suspensions` — the exact mechanism
//   `submit_plan`/`ask_user` already use.
// - `electron/handlers/agent.ts`'s existing `respondSuspension(projectId,
//   threadId, { toolCallId, resumeData })` IPC handler already calls
//   `session.respondToToolSuspension(...)` generically for ANY suspended
//   tool (its `isSubmitPlan` branch is the only tool-specific special case,
//   and `generate_demo` doesn't hit it) — so Task 13's renderer can resume a
//   suspended `generate_demo` call with ZERO new IPC surface, just
//   `apis.agent.respondSuspension(projectId, threadId, { toolCallId,
//   resumeData: { action, guidance } })`.
//
// So: no custom `workflow_suspended` event, no new `agent.resumeWorkflow`
// handler. The tool's own `suspendSchema`/`resumeSchema` below carry exactly
// the locked `{ runId, sceneId, failure, attempts }` / `{ action, guidance? }`
// shapes — same payload the brief's fallback custom event would have
// carried, just delivered as the native `tool_suspended` event's
// `suspendPayload`/`resumeSchema` fields instead.
//
// Suspend/resume in Mastra workflow steps is snapshot-replay (see
// workflows/demo-video.ts's file header): resuming a suspended `Tool.execute`
// call is the SAME re-invoke-from-the-top model (confirmed in the compiled
// `Tool` wrapper, `node_modules/@mastra/core/dist/tool-B09dFqXW.js` ~line
// 583 — `originalExecute(data, organizedContext)` runs again on resume, this
// time with `context.agent.resumeData` populated). A fresh invocation has no
// closure over the in-flight `demo-video` run, so its `runId` is tracked
// out-of-band here, keyed by threadId — the workflow run itself is
// recoverable from `mastra`'s LibSQLStore via `workflow.createRun({ runId })`
// regardless, but the runId string itself has to come from somewhere. A
// plain in-memory map is sufficient because Electron's main process is
// long-lived for a session; it does NOT survive an app restart mid-suspension.
// Fallback only (code review fix #5) — `resumeData.runId` (below) is
// preferred whenever the caller supplies it, since it rides the
// `tool_suspended` event's `suspendPayload` all the way to the renderer and
// back, and so survives exactly the restart this map doesn't.
const activeDemoRuns = new Map<string, string>()

const generateDemoTool = createTool({
  id: "generate_demo",
  description:
    "Run the approved demo plan through the demo-video pipeline: record every scene, verify, narrate, compose. Call exactly once with the approved plan.",
  inputSchema: z.object({ plan: scenePlanSchema }),
  outputSchema: z.object({ videoPath: z.string() }),
  suspendSchema: z.object({
    runId: z.string(),
    sceneId: z.string(),
    failure: z.string(),
    attempts: z.number(),
  }),
  resumeSchema: z.object({
    action: z.enum(["retry", "skip", "abort"]),
    guidance: z.string().optional(),
    // Code review fix #5: carried back from the suspend payload so a
    // resume can recover the run even if `activeDemoRuns` lost its entry
    // (e.g. an app restart). Optional because Task 13's renderer may not
    // echo it back yet — falls back to the in-memory map either way.
    runId: z.string().optional(),
  }),
  execute: async (input, context) => {
    const ctx = readControllerCtx(context.requestContext)
    const threadId = threadIdFromCtx(ctx)
    if (!threadId) {
      throw new Error("generate_demo: no threadId in request context")
    }
    const projectId = ctx?.resourceId
    if (!projectId) {
      throw new Error("generate_demo: no projectId (resourceId) in request context")
    }

    const workspace = ensureWorkspace(threadId)
    const modelId = ctx?.session.modelId || DEFAULT_MODEL_ID
    const workflow = mastra.getWorkflow("demo-video")

    const resumeData = context.agent?.resumeData
    const toolCallId = context.agent?.toolCallId

    // Code review fix #2 (round 2): the round-1 fix forwarded the RAW
    // `ToolStream`-wrapped chunk, which is wrong two ways, both confirmed in
    // compiled source:
    //  (a) `ToolStream._write` (types-C59tsW89.js:21-36) wraps whatever
    //      `sceneStep`'s `writer.write(data)` is given as
    //      `{ type: "workflow-step-output", runId: <workflow runId>, from:
    //      "USER", payload: { output: data, runId, stepName } }` — NOT the
    //      `{type:"scene-progress",...}` object itself. Forwarding that
    //      wrapper raw hits `AgentController.processStreamChunk`'s `default:
    //      break` (agent-controller-ByW51eCC.js:872) — no case recognizes
    //      `"workflow-step-output"` — so the chunk is silently dropped.
    //  (b) Worse: `processStreamChunk`'s very first line, run for EVERY
    //      chunk regardless of type (agent-controller-ByW51eCC.js:279):
    //      `if ("runId" in chunk && chunk.runId) this.#session.run.setRunId({
    //      runId: chunk.runId })`. The wrapped chunk's top-level `runId` is
    //      the WORKFLOW run's id — forwarding it stomps the session's own
    //      agent-run id on every single scene-progress write, corrupting
    //      suspension registration / active-run bookkeeping until the next
    //      real agent chunk overwrites it back.
    // Fixed: unwrap `payload.output` to recover the real scene-progress
    // object, and re-shape into the ONE chunk shape the controller actually
    // recognizes for arbitrary tool progress —
    // `case "data-mastracode-tool-progress"` (agent-controller-ByW51eCC.js:
    // 831-846): `{ type: "data-mastracode-tool-progress", data: {
    // toolCallId, progress } }`, converted there into a `tool_update` event
    // (`partialResult: d.progress`) the renderer can read. This new chunk
    // has no top-level `runId` key at all, so the stomp in (b) cannot
    // happen. Filtered to `record-scene`'s own writes only (`stepName`
    // check) — forwarding any OTHER raw engine-internal chunk here would
    // reintroduce the same stomp risk for whatever `runId` IT happens to
    // carry, so nothing else is passed through.
    const outputWriter = async (chunk: unknown) => {
      const c = chunk as {
        type?: string
        payload?: { output?: unknown; stepName?: string }
      }
      if (c?.type !== "workflow-step-output" || c.payload?.stepName !== "record-scene") {
        return
      }
      const progress = c.payload?.output
      if (!toolCallId || progress === undefined) return
      await context.writer?.custom({
        type: "data-mastracode-tool-progress",
        data: { toolCallId, progress },
      })
    }

    let run: Awaited<ReturnType<typeof workflow.createRun>>
    let result: Awaited<ReturnType<typeof run.start>>

    if (resumeData) {
      // Code review fix #5: prefer the runId carried on resumeData; the
      // in-memory map is the fallback for callers that don't send it yet.
      const runId = resumeData.runId ?? activeDemoRuns.get(threadId)
      if (!runId) {
        throw new Error(
          "generate_demo: no active demo-video run found to resume for this " +
            "thread (the app may have restarted while a scene decision was pending)"
        )
      }
      run = await workflow.createRun({ runId })
      activeDemoRuns.set(threadId, runId)

      // Code review fix #3: the tool's own abortSignal (session cancel)
      // never reached the workflow run otherwise — `Run` gets its own
      // internal AbortController, so cancelling the chat session did
      // nothing to an in-flight `demo-video` run. Cancel the run explicitly
      // (`Run.cancel()`, workflow.d.ts) when the session aborts. Round 2:
      // `.catch()` the cancel call (a bare `void run.cancel()` is a floating
      // promise — an unhandled rejection there crashes the Electron main
      // process), and check `abortSignal.aborted` up front — an
      // already-aborted signal never fires a fresh `"abort"` event, so
      // `addEventListener` alone would silently never cancel a run started
      // after the session was already cancelled.
      const onAbort = () => {
        run.cancel().catch((err: unknown) => log.error("[generate_demo] run.cancel failed:", err))
      }
      if (context.abortSignal?.aborted) onAbort()
      else context.abortSignal?.addEventListener("abort", onAbort)
      try {
        result = await run.resume({ step: "record-scene", resumeData, outputWriter })
      } catch (err) {
        // Code review fix #4: without this, a throw here left `activeDemoRuns`
        // pointing at a runId whose run is now in an unknown/broken state —
        // a later resume could reconnect to a dead run instead of failing
        // clearly.
        activeDemoRuns.delete(threadId)
        throw err
      } finally {
        context.abortSignal?.removeEventListener("abort", onAbort)
      }
    } else {
      const project = getProject(projectId)
      const voiceId = project?.meta.voiceId ?? null

      run = await workflow.createRun()
      activeDemoRuns.set(threadId, run.runId)

      const onAbort = () => {
        run.cancel().catch((err: unknown) => log.error("[generate_demo] run.cancel failed:", err))
      }
      if (context.abortSignal?.aborted) onAbort()
      else context.abortSignal?.addEventListener("abort", onAbort)
      try {
        // `elevenLabsKey` is intentionally NOT included here (code review
        // fix #4) — see the workflow's `inputSchema` comment: it would
        // otherwise be persisted in plaintext into the workflow's LibSQL
        // snapshot. `ttsStep`/`narrateStep` re-read it themselves at
        // execution time.
        result = await run.start({
          inputData: { plan: input.plan, workspace, modelId, voiceId },
          outputWriter,
        })
      } catch (err) {
        activeDemoRuns.delete(threadId)
        throw err
      } finally {
        context.abortSignal?.removeEventListener("abort", onAbort)
      }
    }

    if (result.status === "suspended") {
      if (!context.agent?.suspend) {
        throw new Error(
          "generate_demo: workflow suspended but no tool-suspension context is available " +
            "(generate_demo must run inside an Agent tool call)"
        )
      }
      // Code review fix #1: `WorkflowResult.suspendPayload` is keyed by
      // STEP ID (`{ "record-scene": { sceneId, failure, attempts } }`),
      // confirmed in the compiled result formatter
      // (agent-0y2cApTZ.js: `suspendPayload[stepId] = rest` inside the
      // `status === "suspended"` branch) — not the flat `{sceneId,...}`
      // shape a naive read assumes.
      const payload = (
        result.suspendPayload as Record<
          string,
          { sceneId: string; failure: string; attempts: number }
        >
      )["record-scene"]
      return await context.agent.suspend({
        runId: run.runId,
        sceneId: payload.sceneId,
        failure: payload.failure,
        attempts: payload.attempts,
      })
    }

    activeDemoRuns.delete(threadId)

    if (result.status !== "success") {
      const detail = result.status === "failed" ? `: ${result.error.message}` : ""
      throw new Error(`demo-video workflow ${result.status}${detail}`)
    }

    return { videoPath: result.result.videoPath }
  },
})

let controller: AgentController<DemioControllerState> | null = null
let initPromise: Promise<AgentController<DemioControllerState>> | null = null

export async function getController(): Promise<
  AgentController<DemioControllerState>
> {
  if (controller) return controller
  if (initPromise) return initPromise

  initPromise = (async () => {
    try {
      return await buildAndInitController()
    } catch (err) {
      // Don't let a failed init (bad DB path, model resolution error, etc.)
      // permanently poison the singleton — null the cached promise so the
      // NEXT getController() call retries from scratch. The current
      // caller's awaited promise is still the rejected one, as expected.
      initPromise = null
      throw err
    }
  })()

  return initPromise
}

async function buildAndInitController(): Promise<
  AgentController<DemioControllerState>
> {
  // Backing Agent that every mode shares (config.agent). Its `model` is a
  // dynamic resolver reading the session's currently-selected modelId out
  // of the request context — this is where getModel()'s existing
  // provider-key + instrumented-fetch logic plugs back in, since
  // AgentControllerConfig has no resolveModel field in this version.
  const agent = new Agent({
    id: "demio-agent",
    name: "Demio",
    instructions: "",
    model: ({ requestContext }) => {
      const ctx = readControllerCtx(requestContext)
      return getModel(ctx?.session.modelId || DEFAULT_MODEL_ID)
    },
  })

  const instance = new AgentController<DemioControllerState>({
    id: "demio",
    // Reuse `mastra.ts`'s shared store rather than constructing a second
    // `LibSQLStore` against the same `~/.demio/mastra.db` file (final-review
    // fix wave, finding #3) — same id/url semantics, one client instance.
    storage: mastraStore,
    stateSchema,
    // yolo: auto-approve tool calls — see stateSchema comment. Without this
    // every tool parks on an unanswerable tool_approval_required gate.
    initialState: { yolo: true },
    agent,
    // Layered above `agent.instructions` at call time (see
    // resolveCurrentModeInstructions / buildAgentMessageStreamOptions in
    // the compiled agent-controller — both config.instructions and the
    // active mode's instructions are combined automatically).
    instructions: chatInstructions(),
    // Fallback only: getOrCreateSession always passes a per-session
    // workspace, which wins over this factory (only invoked if a caller
    // creates a session without one).
    workspace: ({ requestContext }) => {
      const threadId = threadIdFromCtx(readControllerCtx(requestContext))
      if (!threadId) {
        throw new Error(
          "AgentController workspace factory: no threadId in request context (scope was not set on the session)"
        )
      }
      return createDemioWorkspace(threadId)
    },
    tools: ({ requestContext }) => {
      const threadId = threadIdFromCtx(readControllerCtx(requestContext))
      const cwd = ensureWorkspace(threadId ?? "unknown")
      // Cast: ai-sdk v7's `tool()` widened `description` to
      // `string | ((options) => string)`; Mastra's vendored ToolsInput
      // union hasn't caught up and still expects a plain string — our
      // tools only ever pass string literals. Same pattern as
      // electron/agent/mastra.ts.
      return {
        present_files: createPresentFilesTool({ cwd }),
      } as ToolsInput
    },
    modes: [
      {
        id: "plan",
        name: "Plan",
        metadata: { default: true },
        transitionsTo: "execute",
        availableTools: PLAN_MODE_TOOLS,
        instructions: [
          "Understand the user's demo request and explore the target site read-only if needed.",
          "Write the scene-by-scene demo plan to a markdown file under plans/ in the workspace,",
          "then call submit_plan({ path }) with the path to that file — never the plan body.",
          "Do NOT output the plan as text. To revise after 'Request changes', edit the same",
          "file in place and call submit_plan again with the same path.",
          "The plan file must contain a fenced json block matching the scene plan schema",
          "(scenes with id/title/goal/startUrl/endUrl/actions/expectedOutcome/narrationHint).",
          "Do not record anything in this mode.",
        ].join(" "),
      },
      {
        id: "execute",
        name: "Execute",
        // No availableTools restriction — full workspace tool access, plus
        // generate_demo layered on top via additionalTools (Task 12).
        additionalTools: { generate_demo: generateDemoTool } as ToolsInput,
        instructions:
          "The plan is approved (activePlan in state; the plan file contains a fenced " +
          "json scene plan). Call generate_demo exactly once with that json plan, " +
          "then present the resulting video with present_files.",
      },
    ],
  })

  await instance.init()
  controller = instance
  return instance
}

const sessions = new Map<string, Session<DemioControllerState>>()

export async function getOrCreateSession(
  projectId: string,
  threadId: string
): Promise<Session<DemioControllerState>> {
  const key = `${projectId}:${threadId}`
  const existing = sessions.get(key)
  if (existing) return existing

  const ctrl = await getController()
  // The controller's own createSession is itself get-or-create, keyed by
  // (resourceId, scope) internally — asking twice returns the same session
  // (in-flight promise cached). This Map is a lighter-weight cache in front
  // of that so repeat calls skip rebuilding the Workspace argument.
  const session = await ctrl.createSession({
    id: key,
    ownerId: projectId,
    resourceId: projectId,
    scope: threadId,
    tags: { projectId, threadId },
    workspace: createDemioWorkspace(threadId),
  })
  // config.initialState seeds NEW sessions only; a reattached session restores
  // its persisted state, and sessions persisted before the yolo default landed
  // would park every tool call on an unanswerable approval gate. Backfill.
  if (session.state.get()?.yolo !== true) {
    await session.state.set({ yolo: true })
  }
  sessions.set(key, session)
  return session
}
