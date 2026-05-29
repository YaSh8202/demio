// Mastra Studio entry point — loaded by `mastra dev` / `mastra build`.
// The production Demio agent is built per-run in electron/agent/mastra.ts.

import { Mastra } from "@mastra/core"
import { demioStudioAgent } from "./agents/demio-studio-agent"

export const mastra = new Mastra({
  agents: { demioStudioAgent },
})
