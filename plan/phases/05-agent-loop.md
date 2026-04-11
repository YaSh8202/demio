# Phase 05 — Agent Loop + Discovery

## Prerequisites
- Phase 02 (agent-browser layer) — `execAgentBrowser()` works
- Phase 04 (Chat UI) — chat panel renders messages and progress cards

## Goals
Connect the AI agent to the chat UI. Set up the Vercel AI SDK `streamText` loop with the `run_browser` tool. The agent can have a conversation with the user, browse websites, take snapshots, and screenshots — the full discovery phase. By the end, you can type "explore cal.com" and watch the agent navigate, snapshot, and report back.

## Tasks

### 5.1 System prompt
- `src/agent/prompts/system.ts`
- Define the agent's identity, capabilities, workflow, and rules
- Include browser control instructions (snapshot before refs, refs invalidate on navigate)
- Include recording workflow outline (so the agent knows the full pipeline)
- Keep it focused — don't over-prompt, let the tools speak for themselves

### 5.2 Implement `run_browser` tool
- `src/agent/tools/browser.ts`
- AI SDK `tool()` definition
- Parameters: `commands` (string | string[])
- Execute: calls `execAgentBrowser()`, returns output
- For screenshot commands, return the file path so the chat UI can display it

```ts
export const runBrowser = tool({
  description: `Execute agent-browser CLI commands for browser automation.
Single command: pass a string. Multiple sequential commands: pass an array.
Use 'snapshot -i' to get element refs (@e1, @e2...). Refs invalidate on navigation.
Use '--json' for structured output. Use semantic locators in scripts (find role/text/testid).`,
  parameters: z.object({
    commands: z.union([z.string(), z.array(z.string())]),
  }),
  execute: async ({ commands }) => {
    const cmds = Array.isArray(commands) ? commands : [commands];
    return execAgentBrowser(cmds);
  },
});
```

### 5.3 Implement `askUser` tool
- `src/agent/tools/askUser.ts`
- When the agent needs user input, it calls this tool
- The tool pauses the agent loop and waits for the user to respond in the chat
- Returns the user's response text

### 5.4 Agent orchestrator
- `src/agent/orchestrator.ts`
- Uses AI SDK `streamText` with Claude model
- Registers tools: `run_browser`, `askUser` (other tools added in later phases)
- Handles the streaming loop: text chunks → chat messages, tool calls → progress cards
- `maxSteps: 30` for discovery (increase later for full pipeline)
- Streams each step to the renderer via IPC

```ts
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

async function runAgent(messages: CoreMessage[]) {
  const result = streamText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: SYSTEM_PROMPT,
    messages,
    tools: { run_browser: runBrowser, ask_user: askUser },
    maxSteps: 30,
    onStepFinish: (step) => {
      // Stream to renderer via IPC
      sendToRenderer('agent:step', step);
    },
  });
  return result;
}
```

### 5.5 Connect orchestrator to chat UI
- `electron/ipc/handlers.ts` — register `agent:send-message` handler that:
  1. Receives user message from renderer
  2. Adds to conversation history
  3. Calls `runAgent()` with full history
  4. Streams text chunks and tool call updates back to renderer
- `src/hooks/useChat.ts` — update to:
  1. On send: call IPC `agent:send-message` with user text
  2. Listen for `agent:text-chunk` → append to current assistant message
  3. Listen for `agent:tool-call` → add/update ProgressCard
  4. Listen for `agent:done` → mark streaming complete

### 5.6 API key management
- `src/lib/config.ts` — simple config store for API keys (Anthropic, ElevenLabs)
- For now: read from environment variables (`ANTHROPIC_API_KEY`)
- Later: add a settings UI for key input
- Keys never leave the main process

### 5.7 Screenshot display in chat
- When `run_browser` returns a screenshot path, the progress card should display it
- IPC to read local files as base64 from renderer (or use Electron's `file://` protocol)
- Thumbnails in progress cards, click to view full-size

## Files to Create/Modify

```
src/agent/
├── orchestrator.ts           # AI SDK streamText loop
├── prompts/
│   └── system.ts             # System prompt
├── tools/
│   ├── browser.ts            # run_browser tool
│   └── askUser.ts            # ask_user tool
└── types.ts                  # Agent-specific types

src/lib/config.ts             # API key management
src/hooks/useChat.ts          # Update: connect to IPC
electron/ipc/handlers.ts      # Agent message handlers
electron/preload.ts           # Expose agent IPC
src/types/ipc.ts              # Agent IPC channel types
```

## Verification
End-to-end test:
1. Set `ANTHROPIC_API_KEY` env var
2. `npm run dev`
3. Type: "Open https://example.com and tell me what you see"
4. Agent calls `run_browser("open https://example.com")`
5. Agent calls `run_browser("snapshot -i")`
6. Agent responds describing the page
7. Progress cards show each browser action with ✓ status
8. Live preview (if Phase 3 done) shows the page

Interactive test:
1. Type: "Explore cal.com — click around and find the event creation flow"
2. Agent navigates, snapshots, clicks, builds understanding
3. Conversation is fluid — user can redirect the agent mid-exploration

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phases 01-04 are complete: Electron scaffold, agent-browser exec layer, and chat UI all work. This is Phase 5: connecting the AI agent.

**Context:**
- `execAgentBrowser(commands: string[])` is available in the main process (from Phase 2)
- Chat UI renders messages and ProgressCards (from Phase 4)
- agent-browser CLI is installed and working

**Task: Implement the AI agent loop using Vercel AI SDK and connect it to the chat UI.**

### 1. System prompt (`src/agent/prompts/system.ts`)

Write the system prompt that defines the agent's behavior:

```
You are Demio, an AI demo video producer. You create professional product demo
videos by browsing a product's website, writing a script, recording screen
interactions, and composing a polished video with voiceover.

## Browser control
You have direct access to the agent-browser CLI via the run_browser tool.
- Pass a single command string or an array of commands (run as batch)
- Use `snapshot -i` to get interactive element refs (@e1, @e2...)
- Refs invalidate on page navigation — always re-snapshot after clicking links
- Use `--json` for structured output when you need to parse results
- Use `screenshot` to capture the current page visually
- Use `screenshot --annotate` for numbered element labels on complex UIs

## Your workflow
1. DISCOVER: Browse the product URL, understand the UI, take screenshots
2. SCRIPT: Write a scene-by-scene script with narration text
3. CONFIRM: Present script to user, wait for approval
4. RECORD: Execute recording scripts per scene
5. VOICEOVER: Generate AI voiceover per scene
6. COMPOSE: Add transitions, zoom effects
7. RENDER: Export final MP4

## Rules
- Present the script for approval before recording
- After each scene recording, show preview and ask if it looks good
- If stuck for 3+ attempts, explain the issue and ask for help
- Keep demos 1-3 minutes unless told otherwise
- When exploring, take screenshots frequently to understand the UI
- If you encounter a login wall, ask for test credentials
```

### 2. `run_browser` tool (`src/agent/tools/browser.ts`)

```ts
import { tool } from 'ai';
import { z } from 'zod';

export const runBrowser = tool({
  description: 'Execute agent-browser CLI commands. Pass a single command string or array for batch execution. Use "snapshot -i" for element refs, "screenshot" for captures.',
  parameters: z.object({
    commands: z.union([
      z.string().describe('Single command, e.g. "open https://example.com"'),
      z.array(z.string()).describe('Multiple commands executed via batch'),
    ]),
  }),
  execute: async ({ commands }) => {
    const cmds = Array.isArray(commands) ? commands : [commands];
    return await execAgentBrowser(cmds);
  },
});
```

### 3. `askUser` tool (`src/agent/tools/askUser.ts`)

Tool for the agent to ask the user questions:
```ts
export const askUser = tool({
  description: 'Ask the user a question and wait for their response',
  parameters: z.object({
    message: z.string(),
    type: z.enum(['question', 'approval', 'preview']),
  }),
  execute: async ({ message, type }) => {
    // Emit message to renderer, then wait for user input
    // This blocks the agent loop until the user responds
    return await waitForUserInput(message, type);
  },
});
```

The `waitForUserInput` function should:
- Send the question to the renderer via IPC
- Return a Promise that resolves when the user's next message arrives
- The orchestrator recognizes this as a "waiting for user" state

### 4. Agent orchestrator (`src/agent/orchestrator.ts`)

```ts
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const model = anthropic('claude-sonnet-4-20250514');

export async function runAgent(conversationHistory: CoreMessage[], onEvent: (event: AgentEvent) => void) {
  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    messages: conversationHistory,
    tools: {
      run_browser: runBrowser,
      ask_user: askUser,
    },
    maxSteps: 30,
    onStepFinish: (step) => {
      onEvent({ type: 'step', data: step });
    },
  });

  // Stream text chunks
  for await (const textPart of result.textStream) {
    onEvent({ type: 'text-chunk', data: textPart });
  }

  return await result;
}
```

### 5. IPC bridge (main ↔ renderer)

**Main process** (`electron/ipc/handlers.ts`):
- `agent:send-message` handler: receives user text, maintains conversation history, calls `runAgent()`, forwards events to renderer
- Keep conversation history in memory in the main process
- Forward events: `agent:text-chunk`, `agent:tool-call-start`, `agent:tool-call-end`, `agent:done`, `agent:error`

**Renderer** (`src/hooks/useChat.ts`):
- On user send: call `window.api.sendMessage(text)` via IPC
- Listen for agent events and update chat state:
  - `text-chunk` → append to current assistant message content
  - `tool-call-start` → add ProgressCard with 'running' status
  - `tool-call-end` → update ProgressCard to 'completed' or 'failed'
  - `done` → mark streaming false
- Handle `askUser` tool: when agent asks a question, show it as an assistant message and re-enable input

### 6. API key config (`src/lib/config.ts`)

Simple config:
- Read `ANTHROPIC_API_KEY` from `process.env`
- Validate on agent start — show error in chat if missing
- Later phases will add ElevenLabs key

### 7. Screenshot display

When the `run_browser` tool result includes a screenshot path (from `agent-browser screenshot` commands):
- Store the path in the ToolCallInfo result
- ProgressCard detects image paths and renders a thumbnail
- Use Electron's `file://` protocol to display local images in the renderer

**Important notes:**
- The agent runs in the **main process** (needs filesystem + subprocess access)
- Text streaming and tool calls flow to the **renderer** via IPC events
- Conversation history is maintained in the main process
- The AI SDK manages the multi-step tool loop automatically via `maxSteps`
- `askUser` pauses the loop — implement as a Promise that resolves on next user message

After implementation:
1. Set ANTHROPIC_API_KEY, run `npm run dev`
2. Type "open example.com and take a screenshot"
3. Agent calls run_browser, screenshot appears in chat
4. Type "explore the page — what links are available?"
5. Agent takes snapshot, reports findings
6. Full interactive conversation works with browser control
```
