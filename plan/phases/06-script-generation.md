# Phase 06 — Script Generation + Shell Scripts

## Prerequisites
- Phase 05 (Agent Loop) — agent can interactively browse with `run_browser` and converse with the user

## Goals
Add the `writeScript` and `editSceneScript` tools. When the agent calls `writeScript`, it produces a structured scene list AND auto-generates a `record.sh` shell script per scene. The agent can then present the script for user approval. By the end, the discovery → script → approval flow works end-to-end.

## Tasks

### 6.1 Define Scene and Script types
- `src/agent/types.ts` (expand existing)

```ts
interface Target {
  kind: 'role' | 'text' | 'label' | 'testid' | 'placeholder' | 'css';
  value: string;       // role name, text content, testid, etc.
  name?: string;       // for role targets: accessible name filter
  exact?: boolean;     // for text targets: exact match
}

interface InteractionStep {
  type: 'navigate' | 'click' | 'fill' | 'type' | 'hover' | 'scroll' | 'wait' | 'waitFor' | 'press' | 'highlight';
  target?: Target;
  url?: string;          // for navigate
  text?: string;         // for fill/type
  key?: string;          // for press
  direction?: string;    // for scroll
  amount?: number;       // for scroll
  durationMs?: number;   // for wait/highlight
  delay?: number;        // for type (ms between keystrokes)
  label?: string;        // for highlight
  description?: string;
}

interface Scene {
  id: string;
  title: string;
  description: string;
  showChapterCard: boolean;
  startUrl?: string;
  steps: InteractionStep[];
  narration: string;
  estimatedDurationMs: number;
}

interface VideoScript {
  title: string;
  targetDurationSeconds: number;
  scenes: Scene[];
  reasoning: string;
}
```

### 6.2 Script generator — Scene → record.sh
- `src/lib/agentBrowser/scriptGenerator.ts`
- `generateRecordScript(scene: Scene): string`
- Converts each InteractionStep into agent-browser CLI lines
- Uses semantic locators (`find role`, `find testid`, `find text`, etc.) — NOT @refs
- Adds appropriate waits between actions
- Header comments with scene metadata
- `stepToShellLine(step: InteractionStep): string[]`
- `targetToCliArgs(target: Target): string`

```ts
function targetToCliArgs(t: Target): string {
  switch (t.kind) {
    case 'role':        return `find role ${t.value}` + (t.name ? ` --name "${t.name}"` : '');
    case 'text':        return `find text "${t.value}"` + (t.exact ? ' --exact' : '');
    case 'label':       return `find label "${t.value}"`;
    case 'testid':      return `find testid ${t.value}`;
    case 'placeholder': return `find placeholder "${t.value}"`;
    case 'css':         return `"${t.value}"`;
  }
}
```

### 6.3 Implement `writeScript` tool
- `src/agent/tools/script.ts`
- Zod schema for parameters (mirrors the Scene/Script types)
- On execute:
  1. Store script in project state
  2. Create `scenes/<scene-id>/` directory per scene
  3. Generate and write `record.sh` per scene via scriptGenerator
  4. Emit script to renderer via IPC
  5. Return script summary for the agent

### 6.4 Implement `editSceneScript` tool
- `src/agent/tools/editScript.ts`
- Parameters: `sceneId`, `newCommands: string[]`
- Overwrites `scenes/<scene-id>/record.sh` with new commands
- Preserves header comments

### 6.5 Project state management
- `src/lib/project.ts`
- In-memory project state (for now):
  - `script: VideoScript | null`
  - `projectDir: string` (temp dir for scene artifacts)
  - `status: 'idle' | 'scripted' | 'recording' | 'composing' | 'done'`
- Create project temp dir on first use
- Save/load `script.json` to the project dir

### 6.6 Register new tools in orchestrator
- `src/agent/orchestrator.ts` — add `writeScript` and `editSceneScript` tools
- Increase `maxSteps` to 50 (script generation + approval loop may take more steps)

### 6.7 Script approval flow
- When agent calls `writeScript`, the tool returns `{ status: 'awaiting_approval' }`
- Agent should then call `askUser` with the script summary
- Chat UI renders the script as a formatted card (scenes, narration, commands)
- User can approve or request changes
- If changes requested, agent calls `writeScript` again with modifications

### 6.8 Script display in chat
- `src/components/chat/ScriptCard.tsx`
- Renders the video script in the chat as a collapsible card
- Shows each scene: title, narration preview, step count, estimated duration
- Expandable: shows full record.sh content per scene
- Approve / Request Changes buttons (when in approval state)

## Files to Create/Modify

```
src/agent/types.ts                       # Scene, Script, InteractionStep types
src/lib/agentBrowser/scriptGenerator.ts  # Scene → record.sh
src/lib/project.ts                       # Project state management
src/agent/tools/script.ts               # writeScript tool
src/agent/tools/editScript.ts           # editSceneScript tool
src/agent/orchestrator.ts               # Register new tools
src/components/chat/ScriptCard.tsx       # Script display in chat
```

## Verification
1. Type: "Make a 60-second demo of creating an event type on cal.com"
2. Agent browses cal.com (discovery — Phase 5)
3. Agent calls `writeScript` with structured scenes
4. Script appears in chat as a formatted card
5. Each scene's `record.sh` exists in the temp project dir
6. `record.sh` files contain valid agent-browser commands with semantic locators
7. User approves → agent acknowledges, ready for recording
8. User says "make scene 2 shorter" → agent calls `editSceneScript` or `writeScript` again

Unit tests:
- `scriptGenerator.test.ts`: every InteractionStep type → correct CLI line
- `scriptGenerator.test.ts`: full Scene → valid record.sh with header + all steps

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phases 01-05 are complete: Electron scaffold, agent-browser exec layer, chat UI, and AI agent loop with interactive browser discovery all work. This is Phase 6: script generation.

**Context:**
- The agent can browse websites via `run_browser` tool and converse with the user
- Now we need the agent to produce structured video scripts AND auto-generate shell scripts
- Each scene becomes a `record.sh` — a shell script of agent-browser commands that can be executed to record that scene

**Task: Implement writeScript and editSceneScript tools, plus the Scene → record.sh generator.**

### 1. Types (`src/agent/types.ts`)

Expand with these types:

```ts
interface Target {
  kind: 'role' | 'text' | 'label' | 'testid' | 'placeholder' | 'css';
  value: string;
  name?: string;       // accessible name for role targets
  exact?: boolean;     // exact text match
}

interface InteractionStep {
  type: 'navigate' | 'click' | 'fill' | 'type' | 'hover' | 'scroll' | 'wait' | 'waitFor' | 'press' | 'highlight';
  target?: Target;     // required for click/fill/type/hover/waitFor/highlight
  url?: string;        // for navigate
  text?: string;       // for fill/type
  key?: string;        // for press (e.g., "Enter", "Tab")
  direction?: string;  // for scroll (up/down/left/right)
  amount?: number;     // for scroll (pixels)
  durationMs?: number; // for wait/highlight
  delay?: number;      // for type (ms between keystrokes, default 60)
  label?: string;      // for highlight (callout text)
  description?: string;
}

interface Scene {
  id: string;                    // e.g., "scene-01-intro"
  title: string;
  description: string;
  showChapterCard: boolean;
  startUrl?: string;
  steps: InteractionStep[];
  narration: string;             // voiceover text
  estimatedDurationMs: number;
}

interface VideoScript {
  title: string;
  targetDurationSeconds: number;
  scenes: Scene[];
  reasoning: string;
}
```

### 2. Script generator (`src/lib/agentBrowser/scriptGenerator.ts`)

Convert a Scene into a record.sh shell script:

```ts
export function generateRecordScript(scene: Scene): string
export function stepToShellLines(step: InteractionStep): string[]
export function targetToCliArgs(target: Target): string
```

Rules:
- Every script starts with `agent-browser set viewport 1280 800`
- If `scene.startUrl`: `agent-browser open <url>` + `agent-browser wait 1000`
- Map each step type to agent-browser commands:
  - navigate → `agent-browser open <url>`
  - click → `agent-browser <targetToCliArgs> click` (for find-style) or `agent-browser click <target>` (for css)
  - fill → `agent-browser <targetToCliArgs> fill "<text>"` or `agent-browser fill <target> "<text>"`
  - type → `agent-browser <targetToCliArgs> type "<text>"` or `agent-browser type <target> "<text>"`
  - hover → `agent-browser hover <target>` + `agent-browser wait <holdMs>`
  - scroll → `agent-browser scroll <direction> <amount>`
  - wait → `agent-browser wait <durationMs>`
  - waitFor → `agent-browser wait <target>`
  - press → `agent-browser press <key>`
  - highlight → inject via eval (generate highlight JS)
- Use semantic locators (`find role button click --name "Submit"`) — NOT @refs
- Header comments: scene id, title, narration preview

For the `find` locator syntax:
- `{ kind: 'role', value: 'button', name: 'Submit' }` → `agent-browser find role button click --name "Submit"`
- `{ kind: 'testid', value: 'new-event-type' }` → `agent-browser find testid new-event-type click`
- `{ kind: 'text', value: 'Sign In' }` → `agent-browser find text "Sign In" click`
- `{ kind: 'label', value: 'Email' }` → `agent-browser find label "Email" fill "value"`
- `{ kind: 'css', value: '#submit' }` → `agent-browser click "#submit"`

Note: for `find` locators, the action (click/fill/type/hover) is appended AFTER the find expression:
`agent-browser find role textbox fill --name "Title" "Product Strategy Session"`

### 3. `writeScript` tool (`src/agent/tools/script.ts`)

AI SDK tool with Zod validation:
- Parameters: title, targetDurationSeconds, scenes (array of Scene with all fields), reasoning
- Execute:
  1. Create project temp dir if not exists
  2. Store script in project state (`src/lib/project.ts`)
  3. For each scene: create `<projectDir>/scenes/<scene.id>/` directory
  4. For each scene: call `generateRecordScript()` and write to `record.sh`
  5. Write `script.json` to project dir
  6. Emit `script:updated` event to renderer via IPC
  7. Return `{ status: 'awaiting_approval', scenePaths: [...] }`

### 4. `editSceneScript` tool (`src/agent/tools/editScript.ts`)

For iterating on individual scenes:
- Parameters: sceneId, newCommands (string array of agent-browser commands)
- Execute: write new record.sh with the provided commands (keeping header comments)

### 5. Project state (`src/lib/project.ts`)

Simple in-memory state for the current project:
```ts
class ProjectState {
  script: VideoScript | null;
  projectDir: string;     // temp dir path
  status: 'idle' | 'scripted' | 'recording' | 'composing' | 'done';
  
  setScript(script: VideoScript): void
  getSceneDir(sceneId: string): string
  getScriptPath(): string
}
```

### 6. ScriptCard component (`src/components/chat/ScriptCard.tsx`)

Chat card that displays the video script:
- Title + total duration + scene count
- Each scene in a collapsible section showing: title, narration text, step count, estimated duration
- When expanded: show the record.sh content in a code block
- When in approval state: show Approve + Request Changes buttons
- Approve click sends a user message "Approved" which the agent picks up

### 7. Register tools in orchestrator

Update `src/agent/orchestrator.ts`:
- Add `write_script: writeScript` and `edit_scene_script: editSceneScript` to tools
- Increase maxSteps to 50

After implementation:
1. Chat: "Make a demo of creating an event on cal.com"
2. Agent explores (Phase 5), then calls writeScript
3. ScriptCard appears in chat with scenes and record.sh previews
4. Approve → agent acknowledges
5. "Make scene 2 shorter" → agent calls editSceneScript or writeScript again
6. Inspect project temp dir: scenes/<id>/record.sh files are valid agent-browser commands
```
