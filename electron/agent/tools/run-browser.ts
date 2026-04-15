// ── Browser Automation Tool ──────────────────────────────────────────────────
//
// AI SDK tool definition for running agent-browser CLI commands.
// The tool wraps execAgentBrowser() and returns the result.

import { tool } from "ai"
import { z } from "zod"
import { execAgentBrowser } from "../../lib/agent-browser/exec"

export const runBrowser = tool({
  description:
    "Execute a browser automation command using agent-browser CLI. " +
    "Supports navigation, clicking, typing, screenshots, and more. " +
    "Pass a single CLI command string (e.g. 'navigate https://example.com', " +
    "'screenshot --json', 'click #submit-button').",
  inputSchema: z.object({
    command: z
      .string()
      .describe(
        "The agent-browser CLI command to execute (e.g. 'navigate https://example.com')"
      ),
  }),
  execute: async ({ command }) => {
    const result = await execAgentBrowser([command], {
      timeout: 60_000,
    })

    return {
      ok: result.ok,
      output: result.output,
      error: result.error ?? null,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    }
  },
})
