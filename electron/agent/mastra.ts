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
// primitives. `createDemioAgent` survives lean (present_files is its only
// custom tool) as the seam for the recorder/narrator agents (Tasks 11/12),
// which get Workspace tools via the `toolFilter` mechanism.

import { Mastra } from "@mastra/core"
import { LibSQLStore } from "@mastra/libsql"
import { mastraDbPath } from "../store/paths"
import { demoVideoWorkflow } from "./workflows/demo-video"

export { createDemioAgent } from "./demio-agent"
export type { CreateDemioAgentOpts } from "./demio-agent"

// Single shared LibSQLStore for `~/.demio/mastra.db` (final-review fix wave,
// finding #3): `controller.ts`'s `AgentController` used to construct its own
// second `LibSQLStore` with the same `id`/`url` instead of reusing this one —
// two separate client instances pointed at the same on-disk SQLite file.
// `controller.ts` already imports this module (for `mastra.getWorkflow(...)`
// in `generateDemoTool`), so importing `mastraStore` from here too is not a
// new/circular dependency — just export the instance and have both call
// sites share it.
export const mastraStore = new LibSQLStore({
  id: "demio-storage",
  url: `file:${mastraDbPath()}`,
})

export const mastra = new Mastra({
  agents: {},
  workflows: { "demo-video": demoVideoWorkflow },
  storage: mastraStore,
})
