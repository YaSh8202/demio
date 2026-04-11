# Phase 02 — agent-browser Integration Layer

## Prerequisites
Phase 01 (Scaffold) completed — Electron app runs with `npm run dev`.

## Goals
Build the subprocess wrapper that executes agent-browser CLI commands from the Electron main process. Handle daemon lifecycle, JSON output parsing, error handling, and first-launch Chrome onboarding. By the end, the main process can run any agent-browser command and get structured results back.

## Tasks

### 2.1 Create `execAgentBrowser()` — core subprocess wrapper
- `src/lib/agentBrowser/exec.ts`
- Spawn `agent-browser` as a child process
- Support single command and batch mode
- Parse `--json` output when present, fall back to raw text
- Handle stderr, exit codes, timeouts
- Resolve binary path: check `node_modules/.bin/agent-browser`, then `which agent-browser`
- Configurable timeout (default 30s, longer for recording)

```ts
interface ExecResult {
  ok: boolean;
  output: string | object;  // parsed JSON or raw text
  error?: string;
  exitCode: number;
  durationMs: number;
}

async function execAgentBrowser(commands: string[]): Promise<ExecResult>
// Single command: spawns `agent-browser <command>`
// Multiple commands: spawns `agent-browser batch "<cmd1>" "<cmd2>" ...`
```

### 2.2 Shell quoting utility
- `src/lib/agentBrowser/quote.ts`
- Properly escape and quote arguments for shell execution
- Handle special characters in selectors, text input, URLs
- Test with edge cases: quotes in text, special chars in selectors

### 2.3 Daemon lifecycle management
- `src/lib/agentBrowser/daemon.ts`
- On app start: ensure daemon is running (any `agent-browser` command auto-starts it, but we should handle cleanup)
- On app quit: `agent-browser close --all` to kill all sessions
- On unclean shutdown recovery: `close --all` on next launch before starting new sessions
- Expose `startDaemon()`, `stopDaemon()`, `isRunning()` functions

### 2.4 Integrate into Electron main process
- `electron/main.ts` — call `startDaemon()` on `app.whenReady()`, call `stopDaemon()` on `before-quit`
- Register IPC handler for renderer to trigger agent-browser commands (used by agent tools later)

### 2.5 Chrome onboarding check
- `src/lib/agentBrowser/chrome.ts`
- Check if Chrome is available: run `agent-browser --version` and parse output
- If Chrome not found: return status indicating install needed
- `installChrome()`: spawn `agent-browser install` with progress reporting

### 2.6 Onboarding UI component
- `src/components/onboarding/ChromeInstall.tsx`
- Shown on first launch if Chrome not detected
- "Install Chrome" button that triggers `agent-browser install`
- Progress indicator during download
- Success state → proceed to main app
- IPC bridge: renderer calls main process to check/install Chrome

### 2.7 Add IPC channels for agent-browser
- `src/types/ipc.ts` — add channel types:
  - `agent-browser:exec` — run command(s), return result
  - `agent-browser:chrome-status` — check Chrome availability
  - `agent-browser:install-chrome` — trigger install
- `electron/ipc/handlers.ts` — register these handlers

## Files to Create/Modify

```
src/lib/agentBrowser/
├── exec.ts              # Core subprocess wrapper
├── quote.ts             # Shell quoting utility
├── daemon.ts            # Daemon lifecycle
└── chrome.ts            # Chrome detection + install

src/components/onboarding/
└── ChromeInstall.tsx     # First-launch onboarding

electron/main.ts          # Add daemon lifecycle hooks
electron/preload.ts       # Expose agent-browser IPC
electron/ipc/handlers.ts  # Register agent-browser IPC handlers
src/types/ipc.ts          # Add IPC channel types
```

## Verification
- Unit test `exec.ts`: mock subprocess, verify JSON parsing, error handling, batch mode
- Unit test `quote.ts`: edge cases with special characters
- Integration test: `execAgentBrowser(['open https://example.com'])` → opens browser, returns success
- Integration test: `execAgentBrowser(['snapshot -i --json'])` → returns parsed accessibility tree
- Batch test: `execAgentBrowser(['open https://example.com', 'snapshot -i', 'screenshot'])` → all succeed
- Chrome check: `checkChrome()` returns version string on machines with Chrome
- Daemon cleanup: quit app, relaunch → no stale daemon errors

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phase 01 (scaffold) is complete — the app runs with `npm run dev`. This is Phase 2: building the agent-browser integration layer.

agent-browser is a Rust CLI that controls Chrome via CDP. It's installed as an npm dep and has a daemon that persists between commands. Commands look like:
- `agent-browser open https://example.com`
- `agent-browser snapshot -i --json`   (accessibility tree with @refs)
- `agent-browser batch "open https://example.com" "snapshot -i" "screenshot"`
- `agent-browser record start ./demo.webm` / `agent-browser record stop`
- `agent-browser set viewport 1280 800`
- `agent-browser close --all`

**Task: Create the subprocess wrapper and daemon lifecycle management.**

### 1. `src/lib/agentBrowser/exec.ts` — Core wrapper

Create an `execAgentBrowser(commands: string[])` function that:
- Takes an array of agent-browser commands
- If 1 command: spawns `agent-browser <command>` directly
- If multiple: spawns `agent-browser batch "<cmd1>" "<cmd2>" ...`
- Parses JSON output when commands include `--json` flag
- Returns a typed result: `{ ok, output, error, exitCode, durationMs }`
- Has a configurable timeout (default 30s)
- Resolves the binary path from node_modules/.bin or PATH
- Uses `child_process.spawn` (not exec) for proper stream handling

### 2. `src/lib/agentBrowser/quote.ts` — Shell quoting

Utility to properly escape arguments for shell execution. Must handle:
- URLs with query params
- Text with quotes and special characters
- Selector strings like `find role button --name "Submit"`
- Batch command wrapping (each command as a quoted arg to batch)

### 3. `src/lib/agentBrowser/daemon.ts` — Daemon lifecycle

- `ensureDaemon()`: called on app start. Any agent-browser command auto-starts the daemon, so this mainly handles cleanup from previous unclean shutdowns by running `close --all`.
- `stopDaemon()`: runs `agent-browser close --all` on app quit.
- `isRunning()`: checks daemon status.

### 4. `src/lib/agentBrowser/chrome.ts` — Chrome detection

- `checkChrome()`: runs `agent-browser --version`, returns `{ available: boolean, version?: string }`
- `installChrome()`: spawns `agent-browser install`, reports progress via callback

### 5. Electron integration

- `electron/main.ts`: call `ensureDaemon()` in `app.whenReady()`, `stopDaemon()` in `before-quit` handler
- `electron/ipc/handlers.ts`: register IPC handlers:
  - `agent-browser:exec` → calls `execAgentBrowser()`
  - `agent-browser:chrome-status` → calls `checkChrome()`
  - `agent-browser:install-chrome` → calls `installChrome()`
- `electron/preload.ts`: expose these via contextBridge
- `src/types/ipc.ts`: add typed channel definitions

### 6. `src/components/onboarding/ChromeInstall.tsx`

React component shown when Chrome is not detected:
- Calls `window.api.checkChromeStatus()` on mount
- Shows a clean install prompt with "Download Chrome" button
- On click: calls `window.api.installChrome()`, shows progress
- On success: transitions to main app

**Important:**
- Use `child_process.spawn` not `exec` (better for streaming output)
- The batch syntax is: `agent-browser batch "cmd1" "cmd2" "cmd3"`
- agent-browser supports `--json` flag on most commands for structured output
- Keep exec.ts generic — it should work with ANY agent-browser command
- Error handling: distinguish between command errors (element not found) vs process errors (binary not found, timeout)
- Reference the agent-browser skill docs for CLI syntax details

After implementation, verify by running from the Electron main process:
1. `execAgentBrowser(['open https://example.com'])` → success
2. `execAgentBrowser(['snapshot -i --json'])` → parsed JSON with @refs
3. `execAgentBrowser(['close'])` → browser closes
4. Quit and relaunch app → no stale daemon issues
```
