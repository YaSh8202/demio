# Phase 09 — Video Composition Pipeline

## Prerequisites
- Phase 07 (Scene Recording) — raw WebM files with timing data exist per scene

## Goals
Port the video processing pipeline from openscreen: decode WebM frames via web-demuxer + WebCodecs, apply visual effects (zoom, highlights, transitions) via Pixi.js, encode back to MP4 via WebCodecs, and mux via mediabunny. By the end, each scene can be composed with effects into a polished `composed.mp4`.

## Tasks

### 9.1 Port StreamingDecoder from openscreen
- `src/lib/video/decoder.ts`
- Adapted from `~/code/github/openscreen/src/lib/exporter/StreamingDecoder.ts`
- Uses `web-demuxer` to parse WebM containers
- Uses `VideoDecoder` (WebCodecs) to decode frames
- Yields `VideoFrame` objects for processing
- Handle WebM-specific quirks (VP8/VP9 codec)

### 9.2 Port FrameRenderer from openscreen
- `src/lib/video/renderer.ts`
- Adapted from `~/code/github/openscreen/src/lib/exporter/FrameRenderer.ts`
- Uses Pixi.js with `OffscreenCanvas` for GPU-accelerated composition
- Simplified from openscreen's full editor — we need:
  - **Zoom**: smooth zoom-in to a region (driven by element coordinates)
  - **Highlight overlay**: colored box or outline around an element with label text
  - **Fade transitions**: fade-in at scene start, fade-out at scene end
  - **Freeze frame**: hold the last frame for padding
- Input: `VideoFrame` + effects config → output: composed `VideoFrame`
- Run in a Web Worker or OffscreenCanvas for performance

### 9.3 Port VideoEncoder wrapper
- `src/lib/video/encoder.ts`
- Uses `VideoEncoder` (WebCodecs) to encode composed frames
- H.264 output at 1280x800, 30fps, ~4Mbps bitrate
- Configurable quality settings

### 9.4 Port VideoMuxer from openscreen
- `src/lib/video/muxer.ts`
- Adapted from `~/code/github/openscreen/src/lib/exporter/VideoMuxer.ts`
- Uses `mediabunny` to write MP4 with fastStart
- Accepts encoded video chunks → writes MP4 file
- Will later also accept audio track (Phase 10)

### 9.5 Composition pipeline — end to end
- `src/lib/video/composePipeline.ts`
- Orchestrates: decode → render → encode → mux
- Input: raw WebM path + effects config
- Output: composed MP4 path

```ts
interface ComposeConfig {
  inputPath: string;     // raw.webm
  outputPath: string;    // composed.mp4
  effects: SceneEffect[];
  width: number;         // 1280
  height: number;        // 800
  fps: number;           // 30
}

interface SceneEffect {
  type: 'zoom' | 'highlight' | 'fade_in' | 'fade_out' | 'freeze';
  startMs: number;
  durationMs: number;
  params: {
    region?: { x: number; y: number; width: number; height: number }; // for zoom
    label?: string;      // for highlight
    color?: string;      // for highlight
  };
}

async function composeScene(config: ComposeConfig): Promise<void>
```

### 9.6 `composeScene` tool
- `src/agent/tools/compose.ts`
- Parameters: sceneId, effects array
- Execute:
  1. Read raw.webm from scene dir
  2. Build ComposeConfig from effects + scene metadata
  3. Run composePipeline
  4. Save to `<sceneDir>/composed.mp4`
  5. Return path + duration

### 9.7 Register tool in orchestrator
- Add `compose_scene` to tools

### 9.8 Composition runs in renderer process
- WebCodecs needs GPU access → run in renderer (or a hidden BrowserWindow worker)
- IPC bridge: main process sends compose request, renderer executes pipeline, returns result
- Progress events: frame count, estimated time remaining
- Use `OffscreenCanvas` + Pixi.js in a worker thread if possible

## Files to Create/Modify

```
src/lib/video/
├── decoder.ts          # web-demuxer + WebCodecs VideoDecoder
├── renderer.ts         # Pixi.js frame composition
├── encoder.ts          # WebCodecs VideoEncoder
├── muxer.ts            # mediabunny MP4 muxer
└── composePipeline.ts  # End-to-end orchestration

src/agent/tools/compose.ts  # composeScene tool
src/agent/orchestrator.ts   # Register tool
electron/ipc/handlers.ts    # Compose IPC (main ↔ renderer)
```

## Verification
1. Have a raw.webm from Phase 7
2. Call compose pipeline with a zoom effect targeting a specific region
3. `composed.mp4` exists and plays in QuickTime/VLC
4. Zoom effect is visible — smooth zoom into the specified region
5. Fade transitions work at scene start/end
6. Output is 1280x800 H.264 at ~30fps
7. Performance: composing a 10-second scene should take <30 seconds

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phases 01-07 are complete: raw WebM recordings exist for each scene. This is Phase 9: video composition pipeline.

**Context:**
- Raw recordings are WebM files (VP8/VP9, 1280x800) from agent-browser's `record` command
- We need to apply visual effects (zoom, highlights, transitions) and output as MP4
- The pipeline from `~/code/github/openscreen/` is proven and should be ported:
  - `openscreen/src/lib/exporter/StreamingDecoder.ts` — web-demuxer + WebCodecs decode
  - `openscreen/src/lib/exporter/FrameRenderer.ts` — Pixi.js frame rendering
  - `openscreen/src/lib/exporter/AudioEncoder.ts` — WebCodecs audio encode
  - `openscreen/src/lib/exporter/VideoMuxer.ts` — mediabunny MP4 muxing
- Packages already installed: `web-demuxer`, `pixi.js`, `pixi-filters`, `gsap`, `mediabunny`

**Task: Port and simplify the video pipeline from openscreen.**

### 1. Decoder (`src/lib/video/decoder.ts`)

Port from `openscreen/src/lib/exporter/StreamingDecoder.ts`:
- Use `web-demuxer` to parse WebM containers (extract video packets)
- Use WebCodecs `VideoDecoder` to decode packets into `VideoFrame` objects
- Yield frames sequentially for processing
- Handle VP8/VP9 codecs (standard WebM output from agent-browser record)

Read the openscreen source first to understand the existing patterns: `~/code/github/openscreen/src/lib/exporter/StreamingDecoder.ts`

### 2. Frame renderer (`src/lib/video/renderer.ts`)

Simplified from `openscreen/src/lib/exporter/FrameRenderer.ts`:
- Uses Pixi.js with OffscreenCanvas
- For each frame, apply active effects:
  - **zoom**: smoothly scale + translate to focus on a region (use GSAP-like easing)
  - **highlight**: draw a rounded rectangle overlay + label text at specified coordinates
  - **fade_in**: alpha transition from 0 to 1 over durationMs
  - **fade_out**: alpha transition from 1 to 0
  - **freeze**: repeat the last frame for N ms (used for padding)
- Input: `VideoFrame` + active effects at current timestamp → output: rendered `VideoFrame`

Read the openscreen renderer to understand setup: `~/code/github/openscreen/src/lib/exporter/FrameRenderer.ts`

### 3. Encoder (`src/lib/video/encoder.ts`)

WebCodecs VideoEncoder:
- H.264 codec (avc1.42001f or similar)
- 1280x800, 30fps
- ~4Mbps bitrate (configurable)
- Outputs `EncodedVideoChunk` objects

### 4. Muxer (`src/lib/video/muxer.ts`)

Port from `openscreen/src/lib/exporter/VideoMuxer.ts`:
- Uses `mediabunny` to write MP4
- Accepts encoded video chunks
- Creates MP4 with fastStart (moov atom at beginning)
- Will later accept audio track too (Phase 10 adds audio muxing)

Read: `~/code/github/openscreen/src/lib/exporter/VideoMuxer.ts`

### 5. Compose pipeline (`src/lib/video/composePipeline.ts`)

Orchestrates the full pipeline:
```ts
async function composeScene(config: {
  inputPath: string;    // raw.webm
  outputPath: string;   // composed.mp4
  effects: SceneEffect[];
  width: number;
  height: number;
  fps: number;
}): Promise<{ durationMs: number }>
```

Flow:
1. Init decoder with inputPath
2. Init renderer with Pixi.js
3. Init encoder with output settings
4. Init muxer with outputPath
5. For each decoded frame:
   - Determine active effects at current timestamp
   - Render through Pixi.js (apply zoom, highlight, fade)
   - Encode the rendered frame
   - Write chunk to muxer
6. For freeze effects: repeat last frame
7. Finalize muxer → MP4 written

### 6. `composeScene` tool (`src/agent/tools/compose.ts`)

```ts
export const composeScene = tool({
  description: 'Apply visual effects to a recorded scene',
  parameters: z.object({
    sceneId: z.string(),
    effects: z.array(z.object({
      type: z.enum(['zoom', 'highlight', 'fade_in', 'fade_out', 'freeze']),
      startMs: z.number(),
      durationMs: z.number(),
      params: z.object({
        region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
        label: z.string().optional(),
        color: z.string().optional(),
      }).optional(),
    })),
  }),
  execute: async ({ sceneId, effects }) => { ... },
});
```

### Critical implementation note:
WebCodecs (VideoDecoder, VideoEncoder) and Pixi.js require a browser/renderer context. The composition pipeline must run in the **Electron renderer process** (or a hidden BrowserWindow used as a worker). Set up IPC so the main process can request composition and the renderer executes it.

**Pattern from openscreen:** openscreen runs the entire export pipeline in the renderer. Follow the same approach — wrap the pipeline in a function called from the renderer, triggered via IPC from main.

After implementation:
1. Have a raw.webm from Phase 7
2. Compose with a zoom effect on a specific region
3. composed.mp4 exists, plays correctly, zoom is smooth
4. Fade transitions visible at start/end
5. Quality matches the raw recording (no major artifacts)
```
