# Demio Electron App — Master Plan

## What is Demio?

Demio generates demo videos from a product URL + description. User describes what to showcase, an AI agent browses the product, writes a script, records screen interactions, generates voiceover (ElevenLabs), and composes a final MP4. Desktop app (Electron) chosen for direct browser process and terminal control.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                 Electron App                         │
│                                                      │
│  ┌─-─────────────┐    ┌───────────────────────-────┐  │
│  │ Main Process  │    │    Renderer Process        │  │
│  │               │    │                            │  │
│  │  AI Agent     │◄──►│  Chat UI (React)           │  │
│  │  (AI SDK      │    │  Live Browser Preview      │  │
│  │   streamText) │    │  Scene Filmstrip           │  │
│  │               │    │  Video Preview             │  │
│  │  Scene Runner │    │  Progress Cards            │  │
│  │  (exec agent- │    │                            │  │
│  │   browser CLI)│    │  Video Pipeline            │  │
│  │               │    │  (WebCodecs + Pixi.js      │  │
│  │  ElevenLabs   │    │   + mediabunny)            │  │
│  │  API calls    │    │                            │  │
│  └───────-───────┘    └──────────────────────────-─┘  │
│         │                                            │
│         ▼                                            │
│  ┌──────────────┐                                    │
│  │ agent-browser │  ← Rust CLI, daemon-backed        │
│  │ (subprocess)  │  ← controls Chrome via CDP        │
│  └──────────────┘                                    │
└─────────────────────────────────────────────────────┘
```

## Key Architectural Decisions

1. **agent-browser over Playwright**: CLI-first, LLM-native refs (@e1, @e2), built-in recording, streaming, daemon-backed. Simpler integration via subprocess.

2. **Terminal tool + typed tools**: Agent gets direct `run_browser` terminal access for all browser interaction. Non-browser operations (voiceover, compose, render, script management) are typed AI SDK tools with Zod schemas.

3. **Shell scripts per scene**: `writeScript` auto-generates a `record.sh` per scene using semantic locators. Scripts are inspectable, reproducible, editable, git-friendly. The scene runner executes them line-by-line, capturing per-step timing.

4. **Runner-captured timing**: Shell scripts stay clean (just agent-browser commands). The SceneRunner wraps each command with wall-clock timestamps for voiceover sync.

5. **No ffmpeg**: Video pipeline uses WebCodecs (decode/encode) + Pixi.js (composition) + mediabunny (MP4 muxing), proven in the openscreen project.

6. **Stream-based live preview**: `agent-browser stream enable` → WebSocket → canvas in Electron renderer. User sees browser activity inside the app.

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop shell | Electron |
| UI | React + TailwindCSS + Radix UI + lucide-react |
| Browser automation | agent-browser CLI (Rust, via subprocess) |
| AI orchestration | Vercel AI SDK (`ai` package), `streamText` with tools |
| LLM | Claude (Anthropic) |
| Voiceover | ElevenLabs API |
| Video decode | web-demuxer + WebCodecs |
| Video encode | WebCodecs API |
| MP4 muxing | mediabunny |
| WebM fix | fix-webm-duration |
| Frame composition | Pixi.js + pixi-filters |
| Animation | GSAP |
| Build | Vite + vite-plugin-electron |

## Agent Tool Surface

| Tool | Type | Purpose |
|------|------|---------|
| `run_browser` | Terminal | Any agent-browser CLI command |
| `writeScript` | Typed | Create/update video script, auto-generate record.sh per scene |
| `editSceneScript` | Typed | Edit a scene's record.sh |
| `executeSceneRecording` | Typed | Run scene script with timing capture |
| `generateVoiceover` | Typed | ElevenLabs TTS for a scene's narration |
| `composeScene` | Typed | Apply zoom, transitions, overlays via Pixi.js |
| `renderVideo` | Typed | Stitch scenes + voiceover into final MP4 |
| `askUser` | Typed | Present question/preview to user, wait for response |

## Agent Flow

```
User: "Make a 60s demo of creating an event in cal.com"
  │
  ▼
Phase 1: DISCOVERY (interactive run_browser)
  open URL → snapshot → screenshot → click around → build mental model
  │
  ▼
Phase 2: SCRIPT (writeScript tool)
  Generate structured script with scenes, steps, narration
  Auto-generate record.sh per scene
  │
  ▼
Phase 3: APPROVAL (askUser tool)
  Present script + shell scripts to user → wait for approval
  │
  ▼
Phase 4: RECORDING (executeSceneRecording tool)
  Per scene: inject cursor CSS → run record.sh line-by-line → capture timing
  │
  ▼
Phase 5: VOICEOVER (generateVoiceover tool)
  Per scene: ElevenLabs TTS → check duration alignment
  │
  ▼
Phase 6: COMPOSITION (composeScene tool)
  Per scene: WebCodecs decode → Pixi.js effects → encode
  │
  ▼
Phase 7: RENDER (renderVideo tool)
  Stitch scenes + chapter cards + voiceover → final.mp4
  │
  ▼
Phase 8: ITERATION
  User requests changes → edit script → re-record only changed scenes → re-render
```

## Project Directory at Runtime

```
<projectDir>/
├── scenes/
│   ├── scene-01-intro/
│   │   ├── record.sh          # Shell script (agent-browser commands)
│   │   ├── raw.webm           # Raw recording
│   │   ├── timing.json        # Per-step timestamps
│   │   ├── voiceover.mp3      # ElevenLabs output
│   │   └── composed.mp4       # Post-composition
│   ├── scene-02-create/
│   │   └── ...
│   └── scene-03-save/
│       └── ...
├── screenshots/                # Discovery-phase captures
├── script.json                 # Full script
└── output/
    └── final.mp4
```

## Reuse from Existing Projects

| From | Use for |
|------|---------|
| `~/code/github/openscreen/src/lib/exporter/VideoMuxer.ts` | MP4 muxing (mediabunny) |
| `~/code/github/openscreen/src/lib/exporter/StreamingDecoder.ts` | WebM decode |
| `~/code/github/openscreen/src/lib/exporter/FrameRenderer.ts` | Pixi.js composition |
| `~/code/github/openscreen/src/lib/exporter/AudioEncoder.ts` | Voiceover → AAC |
| `~/code/github/openscreen/electron/ipc/handlers.ts` | IPC security patterns |
| `~/code/github/demos/calcom-demo/` | Fake cursor CSS + ripple effects |
| `fix-webm-duration` npm package | WebM duration repair |

## Phases

| # | Phase | Depends On | Description |
|---|-------|-----------|-------------|
| 01 | [Scaffold](phases/01-scaffold.md) | — | Electron + React + Vite + Tailwind boilerplate |
| 02 | [agent-browser Layer](phases/02-agent-browser-layer.md) | 01 | Subprocess wrapper, daemon lifecycle, onboarding |
| 03 | [Live Preview](phases/03-live-preview.md) | 02 | WebSocket stream → canvas in Electron |
| 04 | [Chat UI](phases/04-chat-ui.md) | 01 | Chat panel, message list, progress cards |
| 05 | [Agent Loop + Discovery](phases/05-agent-loop.md) | 02, 04 | AI SDK streamText, run_browser tool, discovery phase |
| 06 | [Script Generation](phases/06-script-generation.md) | 05 | writeScript tool, Scene schema, record.sh generation |
| 07 | [Scene Recording](phases/07-scene-recording.md) | 06 | SceneRunner, timing capture, cursor injection |
| 08 | [Voiceover](phases/08-voiceover.md) | 07 | ElevenLabs integration, duration alignment |
| 09 | [Video Composition](phases/09-video-composition.md) | 07 | WebCodecs + Pixi.js pipeline from openscreen |
| 10 | [Audio Sync + Final Render](phases/10-audio-sync-render.md) | 08, 09 | Voiceover placement, chapter cards, MP4 muxing |
| 11 | [Iteration + Polish](phases/11-iteration-polish.md) | 10 | Scene-level re-recording, zoom, transitions, filmstrip |

```
Phase:  01 ──► 02 ──► 03
                │
        01 ──► 04     05 ──► 06 ──► 07 ──► 08 ──┐
                │      │                    │     │
                └──────┘              09 ───┘     ▼
                                      │          10 ──► 11
                                      └──────────┘
```
