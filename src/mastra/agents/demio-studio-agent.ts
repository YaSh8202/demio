// Studio/dev-server agent for `bun run mastra:dev`.
// Uses Mastra's model router + env API keys — not the Electron provider-key store.

import { Agent } from "@mastra/core/agent"

const studioModel =
  process.env.MASTRA_STUDIO_MODEL ?? "anthropic/claude-sonnet-4-5"

export const demioStudioAgent = new Agent({
  id: "demio",
  name: "Demio (Studio)",
  instructions: `You are Demio running in Mastra Studio dev mode.

This is a lightweight agent for testing prompts and tool wiring in Studio — not the full Electron app (no browser automation, workspace, or provider-key store).

Answer helpfully and concisely. If asked about video demos, explain that full Demio runs via \`bun start\` in the Electron app.`,
  model: studioModel,
  tools: {},
})
