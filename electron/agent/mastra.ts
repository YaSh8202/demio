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
// the Phase 2 recorder/narrator agents (Task 11), which will get Workspace
// tools via a `toolFilter` mechanism rather than these ad-hoc tool factories.

import { Mastra } from "@mastra/core"
import { Agent } from "@mastra/core/agent"
import type { ToolsInput } from "@mastra/core/agent"
import { getModel } from "./providers"
import { systemPrompt } from "./prompts"
import { createPresentFilesTool } from "./tools/present-files"
import { createVoiceoverTool } from "./tools/voiceover"

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
  /** ElevenLabs voice id selected for this project. Null = no voiceover. */
  voiceId?: string | null
  /** Human-readable voice name surfaced in the system prompt for tone cues. */
  voiceName?: string | null
  /** Decrypted ElevenLabs API key. Null = no voiceover. */
  elevenLabsKey?: string | null
}

export function createDemioAgent(opts: CreateDemioAgentOpts) {
  const voiceConfigured = Boolean(opts.voiceId && opts.elevenLabsKey)

  return new Agent({
    id: "demio",
    name: "Demio",
    instructions: systemPrompt({
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
    tools: {
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
    } as ToolsInput,
  })
}
