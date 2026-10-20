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
import { chatInstructions, threadContextInstructions } from "./prompts"
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
import { recordRun } from "./workflows/scorecard"
import type { Degradation } from "./workflows/scorecard"
import { stallNudges } from "./stall-state"
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
  // So a video the harness salvaged while the agent was still in this mode
  // (`./stall-watchdog`) can be put in front of the user from here.
  "present_files",
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

// ── generate_demo / runDemoVideo ─────────────────────────────────────────────
//
// Runs the `demo-video` workflow. It no longer suspends (ADR-013): a scene
// that fails its takes is dropped inside the workflow and the run goes on, so
// there is no run to find again later and no `retry | skip | abort` to route
// back in. What is left is one function with two callers — the model, through
// the `generate_demo` tool, and the stall watchdog, when the model never gets
// that far (`./stall-watchdog`).

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

export interface DemoVideoOutcome {
  videoPath: string
  scenes: number
  degraded: Degradation[]
}

/**
 * Run the demo-video workflow for a thread, to its end.
 *
 * Resolves with a video — possibly a degraded one; `degraded` says how. Throws
 * only for the run nothing could save (no ffmpeg, no browser, an unreachable
 * site, a cancel), and writes the scorecard's run line for that ending too.
 */
export async function runDemoVideo(o: {
  projectId: string
  threadId: string
  plan: z.infer<typeof scenePlanSchema>
  modelId: string
  signal?: AbortSignal
  outputWriter?: (chunk: unknown) => Promise<void>
  /** How the harness got here, for the run line: see `./stall-watchdog`. */
  nudges?: number
  salvaged?: boolean
}): Promise<DemoVideoOutcome> {
  const workspace = ensureWorkspace(o.threadId)
  const voiceId = getProject(o.projectId)?.meta.voiceId ?? null
  const run = await mastra.getWorkflow("demo-video").createRun()

  // The caller's abort (a session cancel) never reaches the workflow run on
  // its own — `Run` has its own internal AbortController. `.catch()` because a
  // floating rejection here crashes the Electron main process, and the
  // up-front check because an already-aborted signal never fires `"abort"`.
  const onAbort = () => {
    run
      .cancel()
      .catch((err: unknown) =>
        log.error("[demo-video] run.cancel failed:", err)
      )
  }
  if (o.signal?.aborted) onAbort()
  else o.signal?.addEventListener("abort", onAbort)

  const fail = async (message: string): Promise<never> => {
    // Spec §12: the login profile is deleted on success, abort and thread
    // deletion — NOT on a plain failure, whose natural next step is a retry,
    // and `save_login` lives only on the rehearse mode with no way back to it.
    if (o.signal?.aborted) void deleteProfile(workspace)
    await recordRun({
      workspace,
      outcome: o.signal?.aborted ? "aborted" : "failed",
      scenes: 0,
      plannedScenes: o.plan.scenes.length,
      nudges: o.nudges,
      salvaged: o.salvaged,
      error: message,
    })
    throw new Error(message)
  }

  let result: Awaited<ReturnType<typeof run.start>>
  try {
    // `elevenLabsKey` is intentionally NOT in the input — it would be
    // persisted in plaintext into the workflow's LibSQL snapshot. The steps
    // that need it re-read it at execution time.
    result = await run.start({
      inputData: {
        plan: o.plan,
        workspace,
        modelId: o.modelId,
        voiceId,
        nudges: o.nudges ?? 0,
        salvaged: o.salvaged ?? false,
      },
      outputWriter: o.outputWriter,
    })
  } catch (err) {
    return fail(
      `demo-video workflow threw: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    o.signal?.removeEventListener("abort", onAbort)
  }

  if (result.status !== "success") {
    // `canceled` and friends carry no `.error` — only `failed` does.
    const detail = result.status === "failed" ? `: ${result.error.message}` : ""
    return fail(`demo-video workflow ${result.status}${detail}`)
  }

  void deleteProfile(workspace)
  return {
    videoPath: result.result.videoPath,
    scenes: result.result.scenes.length,
    degraded: result.result.degraded,
  }
}

/** What the model must pass on to the user about a degraded run — in the harness's words, not its own. */
export function degradationNote(degraded: Degradation[]): string {
  if (degraded.length === 0) return ""
  const lines = degraded.map(
    (d) => `- ${d.stage}${d.sceneId ? ` (${d.sceneId})` : ""}: ${d.reason}`
  )
  return (
    "The video was delivered, but not everything in the plan made it in. " +
    "Tell the user exactly this, and offer to re-record what was dropped:\n" +
    lines.join("\n")
  )
}

const generateDemoTool = createTool({
  id: "generate_demo",
  description:
    "Run the approved demo plan through the demo-video pipeline: record every scene, verify, narrate, compose. Call exactly once with the approved plan. It always returns a video; `note` says what, if anything, had to be left out.",
  inputSchema: z.object({ plan: scenePlanSchema }),
  outputSchema: z.object({
    videoPath: z.string(),
    scenes: z.number(),
    note: z.string(),
  }),
  execute: async (input, context) => {
    const ctx = readControllerCtx(context.requestContext)
    const threadId = threadIdFromCtx(ctx)
    if (!threadId) {
      throw new Error("generate_demo: no threadId in request context")
    }
    const projectId = ctx?.resourceId
    if (!projectId) {
      throw new Error(
        "generate_demo: no projectId (resourceId) in request context"
      )
    }
    const toolCallId = context.agent?.toolCallId

    // `sceneStep`'s `writer.write(data)` arrives wrapped by `ToolStream._write`
    // as `{ type: "workflow-step-output", runId: <WORKFLOW runId>, payload:
    // { output: data, stepName } }`. Forwarded raw it is dropped
    // (`processStreamChunk` has no case for it) — and worse, that function's
    // first line copies any chunk's top-level `runId` onto the session,
    // stomping the agent-run id with the workflow's on every progress write.
    // So: unwrap `payload.output` and re-shape it into the one chunk the
    // controller recognises for tool progress, which carries no `runId`.
    // Filtered to `record-scene` only — any other engine chunk passed through
    // would bring the same stomp with it.
    const outputWriter = async (chunk: unknown) => {
      const c = chunk as {
        type?: string
        payload?: { output?: unknown; stepName?: string }
      }
      if (
        c?.type !== "workflow-step-output" ||
        c.payload?.stepName !== "record-scene"
      ) {
        return
      }
      const progress = c.payload?.output
      if (!toolCallId || progress === undefined) return
      await context.writer?.custom({
        type: "data-mastracode-tool-progress",
        data: { toolCallId, progress },
      })
    }

    const outcome = await runDemoVideo({
      projectId,
      threadId,
      plan: input.plan,
      modelId: ctx?.session.modelId || DEFAULT_MODEL_ID,
      signal: context.abortSignal,
      outputWriter,
      nudges: stallNudges(`${projectId}:${threadId}`),
    })
    return {
      videoPath: outcome.videoPath,
      scenes: outcome.scenes,
      note: degradationNote(outcome.degraded),
    }
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
    // The one place the agent learns what the user typed into the home
    // screen's domain box. `chatInstructions()` below is a static string
    // (it has to be — the controller composes it once), and the domain
    // lives on the project, not in the first message. Without this the
    // agent's first move was to ask "Which URL?" and recommend the Vite dev
    // server it found on localhost. The controller calls
    // `getInstructions({ requestContext })` per turn and puts the result
    // ahead of the harness + mode instructions, so this is a preamble.
    instructions: ({ requestContext }) => {
      const ctx = readControllerCtx(requestContext)
      const projectId = ctx?.resourceId
      const project = projectId ? getProject(projectId) : null
      return threadContextInstructions({
        domain: project?.project.domain ?? null,
        projectName: project?.project.name ?? null,
        voiceName: project?.meta.voiceName ?? null,
      })
    },
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
          "then present the resulting video with present_files. generate_demo always " +
          "returns a video; when its `note` is not empty, some of the plan was left " +
          "out — relay the note to the user as written and offer to re-record.",
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
