// ── Mastra runtime ───────────────────────────────────────────────────────────
//
// Exports a singleton `mastra` instance for future Studio / API CLI use, and a
// `createDemioAgent` factory that builds a per-run Agent. Tools depend on the
// per-run workspace `cwd` (and the terminal tool on the per-run `AbortSignal`),
// so the demio agent itself isn't statically registered on `mastra` — the
// factory mirrors the current per-run construction pattern.
//
// Tools are passed through as-is: ai-sdk's `tool({...})` shape is accepted by
// Mastra's `ToolsInput` (the type union includes `VercelTool | VercelToolV5`).

import { Mastra } from "@mastra/core"
import { Agent } from "@mastra/core/agent"
import { getModel } from "./providers"
import { systemPrompt } from "./prompts"
import { createTerminalTool } from "./tools/terminal"
import { createPresentFilesTool } from "./tools/present-files"
import { createReadTool } from "./tools/read"
import { createEditTool } from "./tools/edit"

export const mastra = new Mastra({
  agents: {},
})

export interface CreateDemioAgentOpts {
  workspace: string
  signal: AbortSignal
  modelId: string
  projectTitle?: string
  threadTitle?: string
  domain?: string | null
}

export function createDemioAgent(opts: CreateDemioAgentOpts) {
  return new Agent({
    id: "demio",
    name: "Demio",
    instructions: systemPrompt({
      workspace: opts.workspace,
      projectTitle: opts.projectTitle,
      threadTitle: opts.threadTitle,
      domain: opts.domain ?? null,
    }),
    model: getModel(opts.modelId),
    // Keys here become the streamed `toolName` — they must match the names
    // referenced in the system prompt and in the `hasToolCall(...)` stop
    // condition in the orchestrator.
    tools: {
      terminal: createTerminalTool({ cwd: opts.workspace, signal: opts.signal }),
      present_files: createPresentFilesTool({ cwd: opts.workspace }),
      read: createReadTool({ cwd: opts.workspace }),
      edit: createEditTool({ cwd: opts.workspace }),
    },
  })
}
