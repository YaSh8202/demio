# Phase 11 — Iteration + Polish

## Prerequisites
- Phase 10 (Audio Sync + Final Render) — full pipeline works end-to-end, final MP4 renders

## Goals
Enable scene-level iteration (re-record/re-voice/re-compose only the changed scene), add polish features (zoom-to-element, smooth transitions, filmstrip navigator), and complete the UX. By the end, the user can iterate on individual scenes without regenerating the entire video.

## Tasks

### 11.1 Script diffing for selective re-generation
- `src/lib/project.ts` — add diff logic
- When the agent calls `writeScript` with an updated script:
  - Compare each scene by `id + steps + narration`
  - Scenes with unchanged id + steps + narration → keep existing recordings
  - Changed scenes → mark for re-recording only
  - New scenes → mark for recording
  - Removed scenes → clean up artifacts
- Return: `{ unchanged: string[], changed: string[], added: string[], removed: string[] }`

### 11.2 Selective re-recording flow
- Agent detects which scenes need re-recording from the diff
- Only calls `executeSceneRecording` for changed/added scenes
- Only calls `generateVoiceover` for scenes with changed narration
- Only calls `composeScene` for scenes with new recordings
- Calls `renderVideo` to re-stitch everything (uses cached artifacts for unchanged scenes)

### 11.3 Zoom-to-element effect
- Enhance `composeScene` tool to support zoom targeting by element coordinates
- Agent workflow: before composing, use `run_browser` to get element bounding box:
  ```
  run_browser(["open <url>", "snapshot -i"])
  run_browser("get box @e5")  →  { x: 340, y: 200, width: 250, height: 40 }
  ```
- Pass these coordinates as the `region` parameter in a zoom effect
- Pixi.js renderer smoothly zooms into the specified region with easing

### 11.4 Transition effects between scenes
- `src/lib/video/renderer.ts` — add transition support:
  - **Crossfade**: blend last N frames of scene A with first N frames of scene B
  - **Slide**: scene B slides over scene A from right
  - **Wipe**: horizontal wipe from left to right
- Transitions are applied during the stitch phase (Phase 10's stitcher)
- Agent can specify transition type per scene boundary

### 11.5 Scene filmstrip navigator
- `src/components/preview/SceneFilmstrip.tsx`
- Horizontal strip at the bottom of the preview panel
- Shows thumbnails for each scene (first frame of each recording)
- Current scene highlighted
- Click to jump to a scene's preview
- Drag to reorder scenes (updates script)
- Shows scene status: recorded ✓, needs re-recording ⚠, pending ○

### 11.6 Scene preview panel modes
- `src/components/preview/PreviewPanel.tsx`
- Multiple modes:
  - **Live browser**: WebSocket stream (during discovery/recording)
  - **Scene preview**: play a single scene's composed.mp4
  - **Final preview**: play the stitched final.mp4
- Mode switches automatically based on agent phase
- Manual mode switching via tabs

### 11.7 Project home screen
- `src/components/project/HomeScreen.tsx`
- Shown when no project is active
- "New Demo" button → opens the chat with a fresh project
- Recent projects list (if we implement persistence)
- Simple and clean

### 11.8 Project form
- `src/components/project/ProjectForm.tsx`
- Quick-start form: product URL + brief description
- Voice selection dropdown (ElevenLabs voices)
- Target duration slider (30s / 60s / 90s / 120s)
- Submit → pre-fills the chat with the user's request

### 11.9 Export options
- `src/components/project/ExportOptions.tsx`
- After final render: show export actions
  - Save to file (file dialog)
  - Open in Finder
  - Copy to clipboard (if supported)
  - Quality settings (re-render at different bitrate/resolution)

### 11.10 Polish: agent UX
- Update system prompt with iteration instructions
- Agent should proactively suggest improvements after initial render
- Agent should offer to adjust pacing, fix timing issues
- Natural conversation flow for iterating: "change scene 2" → agent updates script → re-records → re-renders

### 11.11 Error boundaries
- Graceful error handling throughout:
  - Browser not found → onboarding
  - API key missing → helpful error in chat
  - Recording failure → agent debugs and retries
  - Composition failure → show error, offer to skip effects
  - Render failure → show error with helpful info

## Files to Create/Modify

```
src/lib/project.ts                       # Script diffing
src/lib/video/renderer.ts               # Transitions, enhanced zoom
src/lib/video/stitcher.ts               # Transition support during stitch

src/components/preview/
├── PreviewPanel.tsx                     # Multi-mode preview
├── SceneFilmstrip.tsx                   # Scene thumbnail strip
└── VideoPlayer.tsx                      # Enhanced player (from Phase 10)

src/components/project/
├── HomeScreen.tsx                       # Welcome / new project
├── ProjectForm.tsx                      # Quick-start form
└── ExportOptions.tsx                    # Post-render actions

src/agent/prompts/system.ts             # Iteration instructions
src/agent/orchestrator.ts               # Updated tool config
```

## Verification
**Iteration:**
1. Complete a full demo render (discovery → script → record → voice → compose → render)
2. Say "make scene 2 shorter — remove the URL field step"
3. Only scene 2's record.sh is updated
4. Only scene 2 is re-recorded, re-voiced, re-composed
5. Final render uses cached scene 1 and 3, re-stitches with new scene 2
6. Total time for iteration is much less than full re-generation

**Polish:**
7. Zoom-to-element works: smooth zoom into a button/field during a scene
8. Crossfade transitions between scenes in the final video
9. Filmstrip shows scene thumbnails, clicking jumps to preview
10. Home screen → new project → chat flow works
11. Export: save final.mp4 to Downloads works

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phases 01-10 are complete: the full pipeline works end-to-end (browse → script → record → voiceover → compose → render → final.mp4). This is Phase 11: iteration and polish.

**Context:**
- The entire video generation pipeline works
- Each scene has: record.sh, raw.webm, timing.json, voiceover.mp3, composed.mp4
- Final video: output/final.mp4 with chapter cards and synced voiceover
- Now we need: scene-level iteration (change one scene without redoing everything), polish features, and complete UX

**Task: Add selective re-generation, zoom-to-element, transitions, filmstrip, and project management UI.**

### 1. Script diffing (`src/lib/project.ts`)

When the agent calls `writeScript` with an updated script, diff against the previous:
```ts
interface ScriptDiff {
  unchanged: string[];   // scene IDs that didn't change (keep artifacts)
  changed: string[];     // scene IDs with modified steps/narration (re-record)
  added: string[];       // new scene IDs
  removed: string[];     // scene IDs no longer in script
}

function diffScripts(oldScript: VideoScript, newScript: VideoScript): ScriptDiff {
  // Compare by scene.id + JSON.stringify(scene.steps) + scene.narration
  // Same id + same steps + same narration = unchanged
  // Same id + different content = changed
  // New ids = added
  // Missing ids = removed
}
```

Update `writeScript` tool to:
1. Diff against existing script
2. Only generate new record.sh for changed/added scenes
3. Return the diff so the agent knows what to re-record

### 2. Selective re-recording flow

The agent's iteration workflow:
1. User says "change scene 2"
2. Agent calls `writeScript` with the updated script → gets diff: `{ changed: ["scene-02"] }`
3. Agent only calls `executeSceneRecording("scene-02")`
4. Agent only calls `generateVoiceover("scene-02", "new narration")`
5. Agent only calls `composeScene("scene-02", effects)`
6. Agent calls `renderVideo()` — render pipeline should:
   - Use cached `composed.mp4` for unchanged scenes
   - Use new `composed.mp4` for changed scenes
   - Re-stitch and re-mux

### 3. Zoom-to-element

The agent can get element coordinates before composing:
```
run_browser(["open https://app.cal.com", "snapshot -i"])
run_browser("get box @e5")
→ { x: 340, y: 200, width: 250, height: 40 }
```

Then call `composeScene` with a zoom effect using those exact coordinates:
```ts
composeScene({
  sceneId: "scene-02",
  effects: [{
    type: "zoom",
    startMs: 1500,
    durationMs: 3000,
    params: { region: { x: 340, y: 200, width: 250, height: 40 } }
  }]
})
```

The Pixi.js renderer should handle smooth animated zoom:
- Ease in over ~500ms
- Hold the zoomed view
- Ease out over ~500ms
- Use a smooth easing function (ease-in-out-cubic)

### 4. Transitions (`src/lib/video/renderer.ts`)

Add transition types to the compose/stitch pipeline:
- **crossfade**: blend last 15 frames of scene A with first 15 frames of scene B (at 30fps = 500ms)
- Agent specifies transitions in the script or compose step

For the stitcher: when transitioning, the last N frames of scene A and first N frames of scene B overlap. During overlap, blend the two frames: `pixel = alpha * frameB + (1 - alpha) * frameA` where alpha ramps from 0 to 1.

### 5. Scene filmstrip (`src/components/preview/SceneFilmstrip.tsx`)

Horizontal strip below the preview:
- Extracts first frame of each scene's raw.webm as thumbnail
- Shows scene title + duration
- Status indicator: ✓ recorded, ⚠ needs rebuild, ○ pending
- Click → switches preview to that scene's composed.mp4
- Current scene highlighted with a border
- Dark theme styling

### 6. Preview panel modes (`src/components/preview/PreviewPanel.tsx`)

Wrapper that switches between:
- `LiveBrowserView` — during discovery/recording (WebSocket stream)
- `VideoPlayer` playing a scene → during iteration/review
- `VideoPlayer` playing final.mp4 → after render
- Tab bar at top to switch manually: "Live" | "Scene" | "Final"
- Auto-switches based on agent activity

### 7. Home screen (`src/components/project/HomeScreen.tsx`)

Shown when app starts with no active project:
- App title + tagline
- "Create New Demo" card
- Clean, dark, centered layout
- Clicking "Create New Demo" opens the chat

### 8. Project form (`src/components/project/ProjectForm.tsx`)

Quick-start form (shown inline or as a dialog):
- Product URL (text input, required)
- Description (textarea: "What should the demo show?")
- Voice selector (dropdown of ElevenLabs voices, optional)
- Duration target (30s / 60s / 90s / 120s radio buttons)
- Submit → builds a message like "Make a 60-second demo of [description] at [url]" and sends to chat

### 9. Export (`src/components/project/ExportOptions.tsx`)

After final render, show in the chat or preview panel:
- "Save to File" button → Electron save dialog
- "Open in Finder" → `shell.showItemInFolder()`
- "Copy Path" → clipboard
- File size and duration info

### 10. System prompt updates

Add to `src/agent/prompts/system.ts`:
```
## Iteration
- When the user requests changes to specific scenes, use writeScript to update the script
- The tool returns a diff — only re-record changed scenes
- Use cached recordings/voiceover for unchanged scenes
- After re-recording and re-composing changed scenes, call renderVideo to re-stitch
- Suggest improvements proactively after initial render (e.g. "Scene 2 could use a closer zoom on the form")
```

After implementation, the full user experience works:
1. Open app → home screen → "Create New Demo"
2. Fill form: URL + description → chat opens with request
3. Agent discovers, scripts, records, voices, composes, renders
4. Final video plays in preview with filmstrip below
5. "Change scene 2 to be faster" → only scene 2 re-processes
6. "Export" → save final.mp4 to Downloads
```
