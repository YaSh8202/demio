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
import { Memory } from "@mastra/memory"
import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { getModel } from "./providers"
import { DEFAULT_MODEL_ID } from "./types"
import { chatInstructions } from "./prompts"
import {
  createDemioWorkspace,
  disposeDemioWorkspace,
} from "./workspace-factory"
import { createPresentFilesTool } from "./tools/present-files"
import { createExecuteCommandTool } from "./tools/execute-command"
import { ensureWorkspace, getWorkspace } from "./workspace"
import { scenePlanSchema } from "./workflows/schemas"
import { rehearseFlow } from "./workflows/rehearse"
import { saveCredentials, deleteProfile } from "./workflows/credentials"
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
 * Rehearse mode's tool visibility allowlist (`availableTools`). Built-in
 * interaction/task tools (`ask_user`, `submit_plan`, `task_*`) use their
 * documented short names; workspace tools use the exposed names
 * `createWorkspaceTools()` actually registers in this @mastra/core version
 * (no short-name rewriting is applied — see file header).
 *
 * write_file/edit_file/mkdir are additions beyond the brief: the mode's
 * instructions require writing the plan file under `plans/` and revising it
 * in place, which needs them.
 *
 * execute_command is still needed for the mode's own light discovery — a
 * quick, read-only look around the target site via the `agent-browser` CLI,
 * PATH-shimmed and invoked through mastra_workspace_execute_command — but
 * the heavy work of actually walking a flow and proving it is delegated to
 * `rehearse_flow`, which must ALSO be in this list (see Step 4 of
 * task-8-brief.md): it arrives via `additionalTools`, and a tool registered
 * that way but missing from `availableTools` is registered and then hidden
 * from the model (`resolveModeActiveTools`/`buildAgentMessageStreamOptions`
 * in the compiled controller — see the brief for line citations).
 */
const REHEARSE_MODE_TOOLS = [
  "mastra_workspace_read_file",
  "mastra_workspace_list_files",
  "mastra_workspace_grep",
  "mastra_workspace_write_file",
  "mastra_workspace_edit_file",
  "mastra_workspace_mkdir",
  "mastra_workspace_execute_command",
  "ask_user",
  "submit_plan",
  "rehearse_flow",
  "save_login",
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

/**
 * Walk one flow off camera and prove it. Defined here rather than in
 * `rehearse.ts` because it needs `readControllerCtx` / `threadIdFromCtx` /
 * `ensureWorkspace`, which are this module's — importing them out would make
 * a cycle with `rehearse.ts`. The runner itself lives in `rehearse.ts`.
 */
const rehearseFlowTool = createTool({
  id: "rehearse_flow",
  description:
    "Walk one flow of the product off camera and prove every step, producing an executable script. Call once per flow, one flow at a time, and read the result before starting the next.",
  inputSchema: z.object({
    flowId: z
      .string()
      .describe(
        "Kebab-case slug, e.g. `create-board`. Scenes from this flow are named <flowId>.01, <flowId>.02, …"
      ),
    label: z.string().describe("Short human name, e.g. 'Create a board'"),
    startUrl: z.string().describe("URL the flow starts from"),
    goal: z.string().describe("What this flow demonstrates, one sentence"),
    guidance: z
      .string()
      .optional()
      .describe(
        "Anything the rehearsal agent cannot discover for itself — an answer the user gave you, or a correction after a previous attempt."
      ),
  }),
  outputSchema: z.object({
    status: z.enum(["done", "blocked"]),
    detail: z.string(),
    sceneIds: z.array(z.string()),
  }),
  execute: async (input, context) => {
    const ctx = readControllerCtx(context.requestContext)
    const threadId = threadIdFromCtx(ctx)
    if (!threadId) {
      throw new Error("rehearse_flow: no threadId in request context")
    }
    return rehearseFlow({
      workspace: ensureWorkspace(threadId),
      modelId: ctx?.session.modelId || DEFAULT_MODEL_ID,
      flow: {
        id: input.flowId,
        label: input.label,
        startUrl: input.startUrl,
        goal: input.goal,
      },
      guidance: input.guidance,
      signal: context.abortSignal,
    })
  },
})

/**
 * Save this run's login into agent-browser's vault (spec §12).
 *
 * The password reaches the vault through the child's stdin and is never
 * written to demio's own storage. It does still pass through this tool's
 * arguments, which the controller persists — see the header comment in
 * `credentials.ts` for exactly what that does and does not protect.
 */
const saveLoginTool = createTool({
  id: "save_login",
  description:
    "Save this run's login credentials into agent-browser's secure vault so recording can log in unattended, then TEST them by signing in. Ask the user for the username and the password with two separate ask_user calls first. Returns `verified: false` if the test sign-in did not work — when that happens, read the login form's DOM and call this again with the real selectors; do not proceed to rehearsal on an unverified login. The vault profile is deleted when the run succeeds or is aborted, or when the thread is deleted.",
  inputSchema: z.object({
    loginUrl: z.string().describe("The login page URL"),
    username: z.string(),
    password: z.string(),
    // Selectors are OMITTED on the first call and supplied only on a retry
    // after `verified: false`. `auth login` auto-detects the form from 12
    // preferred patterns plus 2 fallbacks, but ONLY when no explicit selector
    // is stored — a supplied one short-circuits all of it
    // (`handle_auth_login`, agent-browser `native/actions.rs:8454`). So a
    // guess is strictly worse than nothing, and three different guesses on
    // this product (`input[name="email"]`, `input[type="email"]`, `#iybm`)
    // produced a total authentication outage that nothing detected.
    //
    // What makes supplying them safe now is that `saveCredentials` TESTS the
    // login and reports `verified`, so a wrong selector comes back
    // immediately instead of surfacing as a scene deviation later. Auto-detect
    // handles most products; the escape hatch exists for the ones it cannot,
    // like a submit control that is a `<div>` rather than a `<button>`.
    usernameSelector: z
      .string()
      .optional()
      .describe(
        "Only after a failed verification. A selector you have READ off the live form, never guessed."
      ),
    passwordSelector: z.string().optional(),
    submitSelector: z
      .string()
      .optional()
      .describe(
        "Only after a failed verification. The clickable submit control — often NOT a <button>; check the DOM."
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    detail: z.string(),
    verified: z
      .boolean()
      .describe("True only if a test sign-in actually left the login form."),
  }),
  execute: async (input, context) => {
    const threadId = threadIdFromCtx(readControllerCtx(context.requestContext))
    if (!threadId) {
      throw new Error("save_login: no threadId in request context")
    }
    return saveCredentials({ workspace: ensureWorkspace(threadId), ...input })
  },
})

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
        // Spec §12 names three deletion sites — success, abort, thread
        // deletion — not "any throw". A plain failure's natural next step is
        // a retry, and there is no second capture path (`save_login` is
        // registered only on the rehearse mode, with no transition back from
        // execute), so deleting the profile here would strand the thread
        // logged out with no way to re-authenticate.
        if (context.abortSignal?.aborted) void deleteProfile(workspace)
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
        // See the matching comment in the resume branch's catch above: a
        // plain failure keeps the profile so a retry can still log in.
        if (context.abortSignal?.aborted) void deleteProfile(workspace)
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
    // Spec §12 names three deletion sites — success, abort, thread deletion —
    // not "any terminal state". A plain `failed` result deliberately keeps
    // the profile: the natural next step after a failed run is a retry, and
    // there is no second capture path (`save_login` lives only on the
    // rehearse mode, with no transition back from execute) — deleting here
    // would strand the thread logged out with no way back in.
    // `deleteProfile` is idempotent and never throws (credentials.ts), so
    // fire-and-forget is safe and keeps cleanup off the result path.
    if (result.status === "success" || context.abortSignal?.aborted) {
      void deleteProfile(workspace)
    }

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
    // Transient connect failures (ECONNRESET / "fetch failed" before any
    // chunk) killed live runs — the deleted orchestrator retried these
    // (modelSettings.maxRetries: 4); restore the same budget here.
    maxRetries: 4,
    model: ({ requestContext }) => {
      const ctx = readControllerCtx(requestContext)
      return getModel(ctx?.session.modelId || DEFAULT_MODEL_ID)
    },
    // Message persistence lives on the AGENT's Memory, not on the harness:
    // the controller only ever passes `memory: { thread, resource }` stream
    // options through (buildAgentMessageStreamOptions), and an Agent with no
    // Memory logs "No memory configured but resourceId and threadId were
    // passed in args" and silently persists NOTHING (agent-0y2cApTZ.js
    // ~30848). Without this: `mastra_messages` stays empty, `listMessages`
    // hydration returns [] (user bubbles never render — they have no live
    // event), history is lost on every restart, and follow-up turns reach
    // the model with no conversation history. Same LibSQLStore instance the
    // harness reads from, so writes and reads meet in one table.
    memory: new Memory({
      storage: mastraStore,
      options: {
        lastMessages: 30,
        // No vector store is configured — leave RAG-style recall off
        // explicitly rather than relying on defaults.
        semanticRecall: false,
      },
    }),
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
      // Fail loudly, matching the `workspace` factory above. The old
      // `threadId ?? "unknown"` fallback silently bound present_files and the
      // shell tool to ~/.demio/workspaces/unknown while the session's own
      // workspace tools kept using the real thread directory — commands would
      // run in a different cwd than the files the agent just read or wrote,
      // with nothing to signal it.
      if (!threadId) {
        throw new Error(
          "AgentController tools factory: no threadId in request context (scope was not set on the session)"
        )
      }
      const cwd = ensureWorkspace(threadId)
      // Cast: ai-sdk v7's `tool()` widened `description` to
      // `string | ((options) => string)`; Mastra's vendored ToolsInput
      // union hasn't caught up and still expects a plain string — our
      // tools only ever pass string literals. Same pattern as
      // electron/agent/mastra.ts.
      return {
        present_files: createPresentFilesTool({ cwd }),
        // Replaces the built-in workspace execute_command (disabled in
        // createWorkspaceForDir) with an identically-named tool that also
        // takes a `description` — the "Shell" card title in the chat UI.
        // `createDemioWorkspace` is cached per thread, so this binds to the
        // same Workspace instance the session was created with.
        mastra_workspace_execute_command: createExecuteCommandTool(
          createDemioWorkspace(threadId)
        ),
      } as ToolsInput
    },
    modes: [
      {
        id: "plan",
        name: "Rehearse",
        metadata: { default: true },
        transitionsTo: "execute",
        availableTools: REHEARSE_MODE_TOOLS,
        additionalTools: {
          rehearse_flow: rehearseFlowTool,
          save_login: saveLoginTool,
        } as ToolsInput,
        instructions: `Rehearse the demo before anything is recorded, then submit a plan for approval.

Discovery is yours; walking flows is not. Open the product and look around with the shell tool if you need to — a handful of pages, snapshots not screenshots — enough to see what flows exist. Then hand each flow to \`rehearse_flow\`, one at a time, and read its result before starting the next. Do not walk a flow yourself; \`rehearse_flow\` is what produces the executable script the recording pass replays.

If the product needs a login: ask for the username with one \`ask_user\` call and the password with a second, then call \`save_login\`. Do this BEFORE the first \`rehearse_flow\` call. Never put a password in any other tool call, and never write one to a file.

\`save_login\` tests the credentials by signing in, and returns \`verified\`. **If \`verified\` is false, stop and fix it — do not rehearse.** An unverified login means every scene behind it will fail with the camera rolling. Open the login page, read the form (\`agent-browser snapshot -i\`, or \`agent-browser eval\` for the actual markup), find the real email, password and submit controls, and call \`save_login\` again passing those selectors. The submit control is the one that catches people out: it is often a \`<div>\` or a styled \`<p>\`, not a \`<button>\`, and the automatic detection only looks for buttons.

If scope is ambiguous — you found eight flows and the user asked for "a demo" — ask early with \`ask_user\`, after a light look around and before rehearsing anything. That one question is what stops you spending an hour proving the wrong flows.

If you are picking up a thread that already has work in it, read \`rehearsal/checkpoint.json\` before doing anything else. A flow still marked \`in-progress\` was interrupted and must be rehearsed again — call \`rehearse_flow\` for it first. Flows marked \`done\` are done; do not re-walk them.

A \`rehearse_flow\` result of \`blocked\` is information, not a dead end. Read the detail. If a person can unblock it, ask them and call \`rehearse_flow\` again with what they told you as \`guidance\`. If nobody can, leave it out of the plan and say so in the report.

When every flow you intend to use is rehearsed, write the plan to a markdown file under plans/ and call \`submit_plan({ path })\` with the path — never the plan body, and never as chat text. To revise after "Request changes", edit the same file and call \`submit_plan\` again with the same path.

The plan file must contain a fenced json block matching the scene plan schema (scenes with id/title/goal/startUrl/endUrl/actions/expectedOutcome/narrationHint).

- Scene \`id\`s must be **exactly** the sceneIds \`rehearse_flow\` returned, in the order it returned them. They are how the harness attaches each proven script to its scene; an id you invent will fail the run.
- Do NOT write a \`script\` field on any scene. The proven scripts already live in \`rehearsal/scripts.json\` and the harness merges them in. Copying them into the plan would create a second, stale copy.

The plan file must ALSO contain a "## Rehearsal report" section, in prose, covering:

- **Flows that could not be completed**, and what stopped each one.
- **One-shot flows** — any flow marked \`oneShot\` because it cannot be run a second time (a real invitation, a cancelled subscription, a first-run wizard). Name each one and say what recording it will actually do. The user needs to decide before approving, not after.
- **What this rehearsal already did to their product** — every \`state-created\` finding. Boards created, invites sent, files uploaded.
- **Anything that deviated from what the user asked for.**

\`rehearsal/findings.md\` in the workspace has all of this; read it before writing the report rather than reconstructing it from memory.

Do not record anything in this mode.`,
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

/**
 * Release the in-memory runtime for a thread that is gone for good.
 *
 * Called from the store IPC handlers when a thread — or the project owning it
 * — is deleted. Drops the cached `Session` and tears down the thread's
 * `Workspace`/`LocalSandbox`, which are otherwise pinned for the lifetime of
 * the Electron main process. Safe to call for a thread that was never opened.
 */
export function disposeThread(projectId: string, threadId: string): void {
  sessions.delete(`${projectId}:${threadId}`)
  // Spec §12's third deletion site. Sync function, async cleanup: the profile
  // name is derived from the workspace path, which is still computable here.
  void deleteProfile(getWorkspace(threadId))
  disposeDemioWorkspace(threadId)
}
