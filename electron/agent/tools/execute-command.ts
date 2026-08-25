// ── execute_command wrapper (description param restoration) ─────────────────
//
// Mastra's built-in `mastra_workspace_execute_command` takes
// `{command, timeout, cwd, tail, background}` and NOTHING else — there is no
// hook in `WorkspaceToolsConfig` to extend a built-in tool's input schema
// (`node_modules/@mastra/core/dist/workspace/tools/types.d.ts` — only
// `enabled`/`requireApproval`/`name`/`maxOutputTokens`/`hooks`). The deleted
// hand-rolled terminal tool DID take a `description`, and the chat UI still
// renders it: `TerminalToolCard` in `src/components/thread/tool-usage.tsx`
// uses `input.description` as the "Shell" row's subtitle. After the Workspace
// migration that field was never populated again, so every shell call renders
// as a bare, unlabelled "Shell" row.
//
// Fix: expose our own tool under the SAME name with the same schema plus a
// required `description`, and delegate execution to Mastra's real
// `executeCommandTool`. Keeping the exposed name identical means
// `PLAN_MODE_TOOLS` (controller.ts), the agent prompts, and the renderer's
// `WORKSPACE_TOOL_NAME_MAP` all keep working untouched.
//
// Why delegation rather than reimplementation: `executeCommandTool.execute`
// is the shared `executeCommand` implementation that also backs the
// background-capable variant — it carries tail-pipe extraction, token-budget
// truncation, the `data-sandbox-stdout/stderr/exit` stream writes, browser-CLI
// CDP injection and workspace tracing spans. None of that is worth re-owning.
// It reads everything it needs off `context.workspace`
// (`requireSandbox(context)`), which the built-in registration path injects
// via `wrapTool()` — assigned (non-workspace) tools get NO workspace in their
// execution context (`listAssignedTools` in
// `node_modules/@mastra/core/dist/agent-0y2cApTZ.js`), so we bind it here
// instead, hence the `createExecuteCommandTool(workspace)` factory.
//
// `background` is kept in the schema even though the exported
// `executeCommandTool` declares the foreground-only variant — both variants
// share one `execute` function, and validation happens against OUR schema at
// the ai-sdk layer, so `get_process_output`/`kill_process` stay usable.

import { createTool } from "@mastra/core/tools"
import { executeCommandTool } from "@mastra/core/workspace"
import type { Workspace } from "@mastra/core/workspace"
import { z } from "zod"

/**
 * Lifted from the deleted `electron/agent/tools/terminal.ts`, which took it
 * from opencode's shell tool (`packages/opencode/src/tool/shell/prompt.ts`) —
 * the few-shot examples are what actually keep the model writing 5-10 word
 * summaries instead of restating the command verbatim.
 */
const DESCRIPTION_PARAM_DOC =
  "Clear, concise description of what this command does in 5-10 words. " +
  "Examples:\nInput: ls\nOutput: Lists files in current directory\n\n" +
  "Input: git status\nOutput: Shows working tree status\n\n" +
  "Input: npm install\nOutput: Installs package dependencies\n\n" +
  "Input: mkdir foo\nOutput: Creates directory 'foo'"

const TOOL_DESCRIPTION = `Execute a shell command in the workspace sandbox.

Examples:
  "npm install && npm run build"
  "ls -la src/"
  "cat config.json | jq '.database'"

Usage:
- Commands run in a shell, so pipes, redirects, and chaining (&&, ||, ;) all work.
- Always quote file paths that contain spaces (e.g. cd "/path/with spaces").
- Use \`timeout\` (in seconds) to bound execution, and \`cwd\` to override the working directory.
- Set \`background: true\` for long-running commands (dev servers, watchers); you get a PID back and read its output later with get_process_output.

Every call MUST include \`description\`: a clear 5-10 word summary of what the command does. It is shown in the chat UI as the shell card's title — without it the user sees an unlabelled row.`

/** Upstream's `NUMERIC_TIMEOUT_STRING_REGEX` (workspace-kJgXwpJp.js:7978). */
const NUMERIC_TIMEOUT_STRING = /^\d+(?:\.\d+)?$/

const inputSchema = z.object({
  command: z
    .string()
    .describe(
      'The shell command to execute (e.g. "npm install", "ls -la src/", "cat file.txt | grep error")'
    ),
  description: z.string().describe(DESCRIPTION_PARAM_DOC),
  // Mirrors the built-in's `z.preprocess(...)` (workspace-kJgXwpJp.js:7983-7989)
  // rather than a bare `z.number()`: models routinely emit `"timeout": "60"`,
  // and the coercion is exactly why upstream wraps it. A plain number schema
  // would reject the string form at the ai-sdk validation layer, failing calls
  // the built-in ran fine.
  timeout: z
    .preprocess((value) => {
      if (typeof value !== "string") return value
      const trimmed = value.trim()
      return NUMERIC_TIMEOUT_STRING.test(trimmed) ? Number(trimmed) : value
    }, z.number())
    .nullish()
    .describe("Maximum execution time in seconds. Example: 60 for 1 minute."),
  cwd: z.string().nullish().describe("Working directory for the command"),
  tail: z
    .number()
    .nullish()
    .describe(
      "For foreground commands: limit output to the last N lines, similar to tail -n. Defaults to 200. Use 0 for no limit."
    ),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run the command in the background. Returns a PID immediately instead of waiting for completion. Use get_process_output to check on it later."
    ),
})

/**
 * ANSI escape sequences — the sandbox env sets FORCE_COLOR=1
 * (workspace-factory.ts), so raw command output is colourised.
 *
 * This is Mastra's own `ANSI_RE` (workspace-kJgXwpJp.js:7890) verbatim, since
 * `toModelOutput` below replaces `sandboxToModelOutput` and is therefore the
 * only stripper that runs. It covers OSC sequences terminated by BEL, ST or
 * \u009C — narrower patterns leave escape garbage behind for tools that emit
 * OSC-8 hyperlinks (`gh`, `ls --hyperlink`). The ESC byte is spliced in from a
 * variable so this source file stays free of control characters.
 */
const ESC = String.fromCharCode(27)
const ANSI_PATTERN = new RegExp(
  `(?:${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\u005C|\\u009C))|(?:[${ESC}\\u009B][\\[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])`,
  "g"
)

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "")
}

/**
 * Build the `description`-carrying replacement for
 * `mastra_workspace_execute_command`, bound to `workspace`.
 *
 * Register it as a normal agent tool AND disable the built-in on the
 * Workspace's tools config (`createWorkspaceForDir` does this) — otherwise the
 * two collide on the same exposed name and the built-in wins, since workspace
 * tools are spread last in the Agent's `allTools` merge.
 */
export function createExecuteCommandTool(workspace: Workspace) {
  return createTool({
    id: "mastra_workspace_execute_command",
    description: TOOL_DESCRIPTION,
    inputSchema,
    execute: async (input, context) => {
      // `description` is display-only — strip it before handing the payload to
      // Mastra's implementation, which would ignore it anyway.
      const { description: _description, ...rest } = input
      return await executeCommandTool.execute!(rest, { ...context, workspace })
    },
    // Mirrors the built-in's `sandboxToModelOutput`: raw output carries ANSI
    // escape sequences that are pure noise — and tokens — for the model.
    toModelOutput: (output: unknown) =>
      typeof output === "string"
        ? { type: "text" as const, value: stripAnsi(output) }
        : (output as never),
  })
}
