// ── Mastra runtime ───────────────────────────────────────────────────────────
//
// Exports a singleton `mastra` instance for future Studio / API CLI use, and a
// `createDemioAgent` factory that builds a per-run Agent. Tools depend on the
// per-run workspace `cwd` (and the voiceover tool on the per-run
// `AbortSignal`), so the demio agent itself isn't statically registered on
// `mastra` — the factory mirrors the current per-run construction pattern.
//
// Tools are passed through as-is: ai-sdk's `tool({...})` shape is accepted by
// Mastra's `ToolsInput` (the type union includes `VercelTool | VercelToolV5`).
//
// Task 7 deleted the hand-rolled orchestrator that used to call this factory
// directly with a full terminal/read/edit/ask_user toolset — the live
// conversation path now runs entirely through AgentController (see
// controller.ts), which brings its own Workspace primitives. `createDemioAgent`
// survives lean (present_files + synthesize_voiceover only) as the seam for
// the Phase 2 recorder/narrator agents (Task 11), which get Workspace tools
// via the `toolFilter` mechanism below rather than these ad-hoc tool
// factories.
//
// Task 11 reconciliation: a plain `Agent` DOES accept a first-class
// `workspace` constructor option — `AgentConfig.workspace?:
// DynamicArgument<AnyWorkspace | undefined, TRequestContext>`
// (`node_modules/@mastra/core/dist/agent/types.d.ts:750`, doc comment:
// "When configured, workspace tools are automatically injected into the
// agent."). Confirmed in the compiled agent (`agent-0y2cApTZ.js`,
// `listWorkspaceTools()`): it calls `this.getWorkspace({ requestContext })`
// then `createWorkspaceTools(workspace, {...})` itself at generate()/stream()
// time — callers never need to call `workspace.init()` or spread
// `workspace.getTools()` by hand. So the recorder just passes a `Workspace`
// instance via the constructor's `workspace` field; tool *restriction* to
// execute/read/edit is done by disabling every other workspace tool on that
// Workspace instance's own `tools: WorkspaceToolsConfig` (top-level
// `enabled: false` + per-tool `{ enabled: true }` overrides — the pattern
// documented at `workspace.d.ts:340-368`), not by post-filtering an injected
// tool map.

import { Mastra } from "@mastra/core"
import { Agent } from "@mastra/core/agent"
import type { ToolsInput } from "@mastra/core/agent"
import { WORKSPACE_TOOLS_PREFIX } from "@mastra/core/workspace"
import type { WorkspaceToolsConfig } from "@mastra/core/workspace"
import { getModel } from "./providers"
import { systemPrompt } from "./prompts"
import { createPresentFilesTool } from "./tools/present-files"
import { createVoiceoverTool } from "./tools/voiceover"
import { createWorkspaceForDir } from "./workspace-factory"

export const mastra = new Mastra({
  agents: {},
})

/**
 * Disable every workspace tool except the ones named in `allowed`. Values
 * are always `{ enabled: true }`/`{ enabled: false }` — a subtype of every
 * per-tool config variant (`ExecuteCommandToolConfig`, `ReadFileToolConfig`,
 * plain `WorkspaceToolConfig`), so the cast to `WorkspaceToolsConfig` (whose
 * keys are individually typed per tool) is safe.
 */
function restrictedWorkspaceToolsConfig(allowed: string[]): WorkspaceToolsConfig {
  const cfg: Record<string, unknown> = { enabled: false }
  for (const name of allowed) {
    if (name.startsWith(WORKSPACE_TOOLS_PREFIX)) cfg[name] = { enabled: true }
  }
  return cfg as WorkspaceToolsConfig
}

export interface CreateDemioAgentOpts {
  workspace: string
  signal: AbortSignal
  modelId: string
  projectTitle?: string
  threadTitle?: string
  domain?: string | null
  /** ElevenLabs voice id selected for this project. Null = no voiceover. */
  voiceId?: string | null
  /** Human-readable voice name surfaced in the system prompt for tone cues. */
  voiceName?: string | null
  /** Decrypted ElevenLabs API key. Null = no voiceover. */
  elevenLabsKey?: string | null
  /**
   * Replace the composed `systemPrompt(...)` entirely. Used by the recorder
   * (Task 11) and narrator (Task 12) agents, which need a scoped one-shot
   * prompt rather than the full chat-agent system prompt.
   */
  instructionsOverride?: string
  /**
   * Restrict the agent's tool set to exactly these names (custom tool names
   * like `present_files`/`synthesize_voiceover`, and/or
   * `mastra_workspace_*` workspace tool names). `undefined` (default) keeps
   * the original unrestricted behavior — present_files + synthesize_voiceover
   * (if configured), no workspace tools. `[]` means no tools at all (the
   * narrator agent, Task 12 — its inputs are inlined, no file/shell access
   * needed).
   */
  toolFilter?: string[]
}

export function createDemioAgent(opts: CreateDemioAgentOpts) {
  const voiceConfigured = Boolean(opts.voiceId && opts.elevenLabsKey)

  const customTools: Record<string, unknown> = {
    present_files: createPresentFilesTool({ cwd: opts.workspace }),
    ...(voiceConfigured
      ? {
          synthesize_voiceover: createVoiceoverTool({
            cwd: opts.workspace,
            voiceId: opts.voiceId as string,
            apiKey: opts.elevenLabsKey as string,
            signal: opts.signal,
          }),
        }
      : {}),
  }

  const tools: Record<string, unknown> =
    opts.toolFilter === undefined
      ? customTools
      : Object.fromEntries(
          Object.entries(customTools).filter(([name]) => opts.toolFilter!.includes(name))
        )

  const workspaceToolNames = (opts.toolFilter ?? []).filter((name) =>
    name.startsWith(WORKSPACE_TOOLS_PREFIX)
  )
  const workspace =
    workspaceToolNames.length > 0
      ? createWorkspaceForDir(opts.workspace, {
          tools: restrictedWorkspaceToolsConfig(workspaceToolNames),
        })
      : undefined

  return new Agent({
    id: "demio",
    name: "Demio",
    instructions:
      opts.instructionsOverride ??
      systemPrompt({
        workspace: opts.workspace,
        projectTitle: opts.projectTitle,
        threadTitle: opts.threadTitle,
        domain: opts.domain ?? null,
        voiceConfigured,
        voiceName: opts.voiceName ?? null,
      }),
    model: getModel(opts.modelId),
    // Keys here become the streamed `toolName` — they must match the names
    // referenced in the system prompt.
    //
    // Cast: ai-sdk v7's `tool()` widened `description` to
    // `string | ((options) => string)` (dynamic per-call descriptions).
    // Mastra's vendored `VercelToolV5` type hasn't caught up and still expects
    // a plain string — our tools only ever pass string literals, so this is a
    // type-level mismatch only.
    tools: tools as ToolsInput,
    ...(workspace ? { workspace } : {}),
  })
}
