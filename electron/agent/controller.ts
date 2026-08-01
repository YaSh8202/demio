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
import { LibSQLStore } from "@mastra/libsql"
import { z } from "zod"
import { getModel } from "./providers"
import { DEFAULT_MODEL_ID } from "./types"
import { chatInstructions } from "./prompts"
import { createDemioWorkspace } from "./workspace-factory"
import { createPresentFilesTool } from "./tools/present-files"
import { ensureWorkspace } from "./workspace"
import { mastraDbPath } from "../store/paths"

/** Re-exported for the IPC handler/preload typing (Task 4). */
export type DemioControllerEvent = AgentControllerEvent

const stateSchema = z.object({
  currentModelId: z.string().optional(),
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
    storage: new LibSQLStore({
      id: "demio-storage",
      url: `file:${mastraDbPath()}`,
    }),
    stateSchema,
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
        // No availableTools restriction — full workspace tool access.
        // generate_demo does not exist yet (Task 12); this mode ships
        // without it for now per the task brief.
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
  sessions.set(key, session)
  return session
}
