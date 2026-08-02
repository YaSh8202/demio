// ── Mastra runtime ───────────────────────────────────────────────────────────
//
// Exports a singleton `mastra` instance registering the `demo-video` workflow
// (Task 12) plus its own storage, and re-exports `createDemioAgent` (now
// defined in `demio-agent.ts` — see that file's header for why it moved: it
// breaks a circular import between this module and
// `workflows/demo-video.ts`, which needs `createDemioAgent` for its narrator
// step while this module needs to import `demo-video.ts` to register the
// workflow).
//
// Task 7 deleted the hand-rolled orchestrator that used to call
// `createDemioAgent` directly with a full terminal/read/edit/ask_user
// toolset — the live conversation path now runs entirely through
// AgentController (see controller.ts), which brings its own Workspace
// primitives. `createDemioAgent` survives lean (present_files +
// synthesize_voiceover only) as the seam for the recorder/narrator agents
// (Tasks 11/12), which get Workspace tools via the `toolFilter` mechanism.

import { Mastra } from "@mastra/core"
import { LibSQLStore } from "@mastra/libsql"
import { mastraDbPath } from "../store/paths"
import { demoVideoWorkflow } from "./workflows/demo-video"

export { createDemioAgent } from "./demio-agent"
export type { CreateDemioAgentOpts } from "./demio-agent"

export const mastra = new Mastra({
  agents: {},
  workflows: { "demo-video": demoVideoWorkflow },
  storage: new LibSQLStore({ id: "demio-storage", url: `file:${mastraDbPath()}` }),
})
