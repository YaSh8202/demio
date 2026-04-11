# Phase 07 — Scene Recording

## Prerequisites
- Phase 06 (Script Generation) — `writeScript` generates `record.sh` per scene

## Goals
Build the SceneRunner that executes a scene's `record.sh` line-by-line with `agent-browser record start/stop`, captures per-step timing events, and saves the raw WebM. Also inject fake cursor CSS for visual polish. By the end, the agent can record each scene and the user can preview raw WebM files.

## Tasks

### 7.1 SceneRunner — line-by-line executor
- `src/lib/agentBrowser/sceneRunner.ts`
- Reads a `record.sh` file, strips comments and blank lines
- Wraps execution with `agent-browser record start` / `record stop`
- Executes each command via `execAgentBrowser()` one at a time
- Captures `performance.now()` before and after each command → timing events
- On failure: stops recording, returns partial timing data + error info
- Saves timing events to `timing.json` in the scene directory

```ts
interface TimingEvent {
  label: string;        // "scene-01:step-3:before" / "scene-01:step-3:after"
  timeMs: number;       // milliseconds since recording started
  command: string;      // the agent-browser command
  ok?: boolean;
}

interface RunResult {
  ok: boolean;
  webmPath?: string;
  timingEvents: TimingEvent[];
  failedStep?: number;
  error?: string;
  durationMs: number;
}

class SceneRunner {
  async execute(scriptPath: string, sceneId: string): Promise<RunResult>
}
```

### 7.2 WebM duration fix
- After recording stops, run `fix-webm-duration` on the raw WebM
- The Playwright/CDP screencast produces WebM with missing duration metadata
- `src/lib/video/fixWebm.ts` — wrapper around the fix-webm-duration package
- Read raw WebM → fix → write fixed WebM (or overwrite)

### 7.3 Fake cursor injection
- `src/lib/agentBrowser/cursor.ts`
- CSS + JS for a custom cursor overlay + ripple click effect
- Ported from `~/code/github/demos/calcom-demo/` pattern
- `injectCursor()` function: runs `agent-browser eval --stdin` with the CSS/JS
- Called once before recording starts for each scene
- Cursor moves smoothly (CSS transition), shows ripple on click
- Must work across page navigations (re-inject on navigate? or use CDP overlay)

### 7.4 `executeSceneRecording` tool
- `src/agent/tools/recording.ts`
- Parameters: `sceneId: string`
- Execute:
  1. Resolve script path: `<projectDir>/scenes/<sceneId>/record.sh`
  2. Inject fake cursor CSS
  3. Call `sceneRunner.execute(scriptPath, sceneId)`
  4. Apply `fix-webm-duration` to the raw WebM
  5. Return `{ sceneId, webmPath, timingEvents, durationMs }`
  6. If failed: return error details so the agent can debug

### 7.5 Recording progress events
- During recording, emit IPC events to update the chat UI:
  - `recording:start` — scene recording initiated
  - `recording:step` — each command executed (for progress bar)
  - `recording:stop` — recording complete
  - `recording:error` — step failed
- ProgressCard in chat shows: scene name, current step / total steps, elapsed time

### 7.6 Scene preview in chat
- After recording, the agent should show the raw WebM to the user
- `askUser` with the WebM path as an attachment
- Chat UI: render a video player for `.webm` attachments using `<video>` element
- User can approve or request re-recording

### 7.7 Register tool in orchestrator
- `src/agent/orchestrator.ts` — add `execute_scene_recording: executeSceneRecording`

### 7.8 Error recovery flow
- If a step fails (element not found, navigation error):
  1. Recording stops automatically
  2. Tool returns failure details: which step, what error, partial timing
  3. Agent uses `run_browser` to investigate (snapshot, screenshot)
  4. Agent calls `editSceneScript` to fix the script
  5. Agent calls `executeSceneRecording` again
- System prompt guidance: "If recording fails, investigate with snapshot and screenshot, fix the script, then retry"

## Files to Create/Modify

```
src/lib/agentBrowser/sceneRunner.ts      # Line-by-line executor with timing
src/lib/agentBrowser/cursor.ts           # Fake cursor CSS/JS injection
src/lib/video/fixWebm.ts                 # fix-webm-duration wrapper
src/agent/tools/recording.ts             # executeSceneRecording tool
src/agent/orchestrator.ts                # Register recording tool
electron/ipc/handlers.ts                 # Recording progress events
src/components/chat/ProgressCard.tsx      # Update: recording progress variant
```

## Verification
1. Have a script generated from Phase 6 (or create a test record.sh manually)
2. Agent calls `executeSceneRecording({ sceneId: "scene-01-intro" })`
3. WebM file exists at `scenes/scene-01-intro/raw.webm`
4. WebM plays in VLC / browser `<video>` element — has correct duration
5. `timing.json` has before/after timestamps per step
6. Fake cursor is visible in the recording (custom cursor + ripple on clicks)
7. On step failure: agent gets error, investigates, fixes script, re-records successfully
8. Chat shows recording progress (step count, elapsed time)

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phases 01-06 are complete: the AI agent can browse websites, generate structured video scripts, and auto-generate record.sh shell scripts per scene. This is Phase 7: scene recording.

**Context:**
- `record.sh` files contain agent-browser commands like:
  ```bash
  agent-browser set viewport 1280 800
  agent-browser open https://app.cal.com/event-types
  agent-browser wait 1500
  agent-browser find testid new-event-type click
  agent-browser find role textbox fill --name "Title" "Strategy Session"
  ```
- `execAgentBrowser(commands)` runs agent-browser CLI from the main process
- agent-browser supports `record start ./file.webm` and `record stop`
- `fix-webm-duration` npm package fixes missing WebM duration metadata

**Task: Build the SceneRunner that executes record.sh scripts with recording and timing capture.**

### 1. SceneRunner (`src/lib/agentBrowser/sceneRunner.ts`)

```ts
interface TimingEvent {
  label: string;     // "scene-01:step-3:before"
  timeMs: number;    // ms since recording started
  command: string;
  ok?: boolean;
}

interface RunResult {
  ok: boolean;
  webmPath?: string;
  timingEvents: TimingEvent[];
  failedStep?: number;
  error?: string;
  durationMs: number;
}
```

Implementation:
1. Read `record.sh`, split into lines, strip comments (`#`) and blank lines
2. Run `agent-browser record start <sceneDir>/raw.webm`
3. Capture `t0 = performance.now()`
4. For each line:
   - Record timing event `{label: "${sceneId}:step-${i}:before", timeMs: now-t0, command: line}`
   - Call `execAgentBrowser([line])` (strip the `agent-browser ` prefix if present in the script)
   - Record timing event `{label: "${sceneId}:step-${i}:after", timeMs: now-t0, ok: result.ok}`
   - If `!result.ok`: run `agent-browser record stop`, return failure with `failedStep: i`
5. Run `agent-browser record stop`
6. Fix WebM duration
7. Write `timing.json` to scene dir
8. Return `{ ok: true, webmPath, timingEvents, durationMs }`

Important: when parsing record.sh, each line starts with `agent-browser ` — strip that prefix and pass the rest to `execAgentBrowser`. E.g., line `agent-browser find role button click --name "Submit"` becomes the command `find role button click --name "Submit"`.

Emit progress events via callback: `onProgress({ step: i, total: lines.length, command: line })`

### 2. WebM fix (`src/lib/video/fixWebm.ts`)

```ts
import fixWebmDuration from 'fix-webm-duration';

export async function fixWebm(inputPath: string): Promise<string>
```
- Read the raw WebM file
- Pass through fix-webm-duration (it patches the duration metadata)
- Write back to the same path (or a new path)
- Return the fixed file path

### 3. Fake cursor (`src/lib/agentBrowser/cursor.ts`)

Port the cursor injection from `~/code/github/demos/calcom-demo/`:
- Custom cursor image (or CSS-drawn circle) that follows the mouse
- Ripple effect on click (expanding circle animation)
- Injected via `agent-browser eval --stdin`

```ts
export async function injectFakeCursor(): Promise<void> {
  const cursorScript = `
    // Hide real cursor
    document.documentElement.style.cursor = 'none';
    // Create fake cursor element
    const cursor = document.createElement('div');
    cursor.id = 'demio-cursor';
    cursor.style.cssText = 'position:fixed;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,0.8);border:2px solid white;pointer-events:none;z-index:999999;transition:left 0.15s ease-out, top 0.15s ease-out;';
    document.body.appendChild(cursor);
    // Track mouse
    document.addEventListener('mousemove', e => {
      cursor.style.left = e.clientX - 10 + 'px';
      cursor.style.top = e.clientY - 10 + 'px';
    });
    // Ripple on click
    document.addEventListener('click', e => {
      const ripple = document.createElement('div');
      ripple.style.cssText = 'position:fixed;border-radius:50%;border:2px solid rgba(59,130,246,0.8);pointer-events:none;z-index:999998;animation:demio-ripple 0.6s ease-out forwards;';
      ripple.style.left = e.clientX - 20 + 'px';
      ripple.style.top = e.clientY - 20 + 'px';
      ripple.style.width = ripple.style.height = '40px';
      document.body.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
    // Ripple animation
    const style = document.createElement('style');
    style.textContent = '@keyframes demio-ripple{0%{transform:scale(0.5);opacity:1}100%{transform:scale(2);opacity:0}}';
    document.head.appendChild(style);
  `;
  await execAgentBrowser([`eval --stdin <<'CURSOREOF'\n${cursorScript}\nCURSOREOF`]);
}
```

Note: This needs to be re-injected after any page navigation since the DOM resets. The SceneRunner should inject it before recording starts and after any `open` command within the script.

### 4. `executeSceneRecording` tool (`src/agent/tools/recording.ts`)

```ts
export const executeSceneRecording = tool({
  description: 'Record a scene by executing its record.sh script. Captures per-step timing, saves raw WebM, injects fake cursor.',
  parameters: z.object({ sceneId: z.string() }),
  execute: async ({ sceneId }, { abortSignal }) => {
    const scriptPath = project.getSceneDir(sceneId) + '/record.sh';
    await injectFakeCursor();
    const result = await sceneRunner.execute(scriptPath, sceneId, (progress) => {
      sendToRenderer('recording:progress', { sceneId, ...progress });
    });
    if (result.ok) {
      await fixWebm(result.webmPath!);
    }
    return result;
  },
});
```

### 5. Progress in chat UI

Update ProgressCard for recording:
- When `toolName === 'execute_scene_recording'` and status is 'running':
  Show scene name + progress bar (current step / total) + elapsed time
- When completed: Show success with duration, link to preview WebM

### 6. Register in orchestrator

Add `execute_scene_recording` to the tools object in `src/agent/orchestrator.ts`.

**Important notes:**
- The `record.sh` lines have `agent-browser ` prefix — strip it before passing to `execAgentBrowser`
- Timing events are critical for voiceover sync in Phase 8 — test that timestamps are accurate
- Cursor injection may need re-injection after navigate commands
- Error on a step should immediately stop recording and return all data collected so far

After implementation:
1. Generate a script with the agent (Phase 6)
2. Agent calls executeSceneRecording for each scene
3. Raw WebM files appear in scene directories
4. WebM plays correctly with visible fake cursor
5. timing.json has accurate per-step timestamps
6. On failure: agent gets error details, can investigate and retry
```
