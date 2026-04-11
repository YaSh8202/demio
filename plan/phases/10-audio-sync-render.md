# Phase 10 — Audio Sync + Final Render

## Prerequisites
- Phase 08 (Voiceover) — `voiceover.mp3` exists per scene
- Phase 09 (Video Composition) — `composed.mp4` exists per scene (video-only)

## Goals
Combine voiceover audio with composed video using timing data. Stitch all scenes together with chapter title cards. Output a single final MP4 with synced audio. By the end, `output/final.mp4` is a complete demo video with voiceover.

## Tasks

### 10.1 Audio decoder
- `src/lib/audio/decoder.ts`
- Decode MP3 (ElevenLabs output) to raw PCM samples
- Use WebCodecs `AudioDecoder` or `AudioContext.decodeAudioData()`
- Output: Float32Array of PCM samples + sample rate + channel count

### 10.2 Audio mixer
- `src/lib/audio/mixer.ts`
- Place voiceover clips on a timeline using timing events
- Each scene's voiceover starts at the scene's start timestamp in the final video
- Handle gaps between scenes (silence)
- Handle overlap protection (shouldn't happen with per-scene voiceover, but safety check)
- Output: single continuous PCM audio stream for the full video duration

```ts
interface AudioClip {
  pcmData: Float32Array;
  sampleRate: number;
  channels: number;
  startTimeMs: number;  // position in the final video timeline
}

function mixAudio(clips: AudioClip[], totalDurationMs: number, outputSampleRate: number): Float32Array
```

### 10.3 Audio encoder
- `src/lib/audio/encoder.ts`
- Port from `~/code/github/openscreen/src/lib/exporter/AudioEncoder.ts`
- Encode PCM → AAC using WebCodecs `AudioEncoder`
- Output: `EncodedAudioChunk` objects ready for muxing

### 10.4 Chapter title cards
- `src/lib/video/titleCard.ts`
- Generate title card frames for each scene:
  - Dark background
  - Scene title (large, centered)
  - Scene description (smaller, below title)
  - Duration: ~2.5 seconds per card
- Render using Pixi.js (same renderer as compose)
- Encode as video frames → feed into the muxer between scenes

### 10.5 Scene stitcher
- `src/lib/video/stitcher.ts`
- Concatenate all scene videos in order with chapter cards between them
- For each scene:
  1. If `showChapterCard`: render and encode title card frames
  2. Decode `composed.mp4` frames
  3. Re-encode (or passthrough if same codec)
  4. Feed to muxer
- Calculate the timeline offset for each scene (used for audio placement)

### 10.6 Full render pipeline
- `src/lib/video/renderPipeline.ts`
- Orchestrates the complete final render:

```ts
async function renderFinalVideo(config: {
  scenes: Array<{
    sceneId: string;
    composedPath: string;     // composed.mp4
    voiceoverPath: string;    // voiceover.mp3
    title: string;
    description: string;
    showChapterCard: boolean;
    timingEvents: TimingEvent[];
  }>;
  outputPath: string;        // output/final.mp4
}): Promise<{ durationMs: number }>
```

Flow:
1. Calculate scene layout: chapter card durations + scene durations → timeline
2. For each scene: decode composed.mp4 → re-encode → feed to muxer
3. Between scenes: render chapter card frames → encode → feed to muxer
4. For each scene: decode voiceover.mp3 → place on audio timeline
5. Mix all audio clips → encode AAC → feed to muxer as audio track
6. Finalize muxer → output/final.mp4

### 10.7 `renderVideo` tool
- `src/agent/tools/render.ts`
- Parameters: `includeChapterCards: boolean`
- Execute:
  1. Gather all scene artifacts (composed video, voiceover, timing)
  2. Call renderPipeline
  3. Return `{ outputPath, durationMs }`
- Emit progress events: current scene / total, encoding progress

### 10.8 Register tool in orchestrator
- Add `render_video` to tools

### 10.9 Video preview in chat
- After render, agent calls `askUser` with the final MP4 as attachment
- Chat UI: video player component for MP4 files
- `src/components/preview/VideoPlayer.tsx` — HTML5 video player with controls
- User can play the final video directly in the app

## Files to Create/Modify

```
src/lib/audio/
├── decoder.ts           # MP3 → PCM decode
├── mixer.ts             # Timeline-based audio mixing
└── encoder.ts           # PCM → AAC encode (from openscreen)

src/lib/video/
├── titleCard.ts         # Chapter title card renderer
├── stitcher.ts          # Scene concatenation
└── renderPipeline.ts    # Full final render orchestration

src/agent/tools/render.ts           # renderVideo tool
src/agent/orchestrator.ts           # Register tool
src/components/preview/VideoPlayer.tsx  # Video player component
```

## Verification
1. Have 2-3 scenes with composed.mp4 and voiceover.mp3 each
2. Agent calls `renderVideo({ includeChapterCards: true })`
3. `output/final.mp4` exists and plays in QuickTime/VLC
4. Chapter cards appear between scenes with correct titles
5. Voiceover is audible and synced with the visuals
6. Voiceover starts at the right time for each scene
7. Transitions between scenes are smooth (no artifacts, no silence gaps beyond expected)
8. Total duration matches expected (sum of chapter cards + scene durations)
9. Video player in chat can play the final MP4

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phases 01-09 are complete: each scene has a composed.mp4 (video with effects) and voiceover.mp3 (narration audio). This is Phase 10: combining everything into the final video.

**Context:**
- Each scene directory has:
  - `composed.mp4` — video with zoom/highlight effects (video-only, no audio)
  - `voiceover.mp3` — ElevenLabs narration audio
  - `timing.json` — per-step timestamps
- The video pipeline from Phase 9 (decoder, encoder, muxer, renderer) is available
- `mediabunny` supports multiple tracks (video + audio)
- Openscreen's AudioEncoder: `~/code/github/openscreen/src/lib/exporter/AudioEncoder.ts`

**Task: Build the audio processing pipeline and final render that stitches scenes with voiceover.**

### 1. Audio decoder (`src/lib/audio/decoder.ts`)

Decode MP3 to raw PCM:
```ts
export async function decodeAudioFile(filePath: string): Promise<{
  pcmData: Float32Array;
  sampleRate: number;
  channels: number;
  durationMs: number;
}>
```

Approach: read the MP3 file, use `AudioContext.decodeAudioData()` in the renderer process (or WebCodecs AudioDecoder with MP3 codec). Return PCM samples.

### 2. Audio mixer (`src/lib/audio/mixer.ts`)

Place audio clips on a timeline and mix to a single output:
```ts
interface AudioClip {
  pcmData: Float32Array;
  sampleRate: number;
  channels: number;
  startTimeMs: number;
}

export function mixAudio(
  clips: AudioClip[],
  totalDurationMs: number,
  outputSampleRate: number = 44100
): Float32Array
```

- Create an output buffer of the right length (totalDurationMs * sampleRate / 1000)
- For each clip: calculate the start sample index, copy/add PCM data into the buffer
- If clips overlap: sum the samples (additive mixing)
- Resample if clip.sampleRate !== outputSampleRate

### 3. Audio encoder (`src/lib/audio/encoder.ts`)

Port from `~/code/github/openscreen/src/lib/exporter/AudioEncoder.ts`:
- Encode PCM Float32Array → AAC using WebCodecs `AudioEncoder`
- Output: `EncodedAudioChunk` stream
- AAC-LC, 44100 Hz, stereo (or mono if source is mono)

### 4. Chapter title cards (`src/lib/video/titleCard.ts`)

Generate video frames for title cards between scenes:
- Dark background (match app dark theme — zinc-900)
- Scene title: large white text, centered
- Scene description: smaller gray text, below title
- Fade in over 500ms, hold for 1500ms, fade out over 500ms = 2500ms total
- Render using Pixi.js (same renderer from Phase 9)
- Return as an array of VideoFrame or encoded chunks

```ts
export async function renderTitleCard(config: {
  title: string;
  description: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
}): Promise<EncodedVideoChunk[]>
```

### 5. Scene stitcher (`src/lib/video/stitcher.ts`)

Concatenate scenes with chapter cards:
```ts
interface StitchScene {
  composedPath: string;
  showChapterCard: boolean;
  title: string;
  description: string;
}

export async function* stitchScenes(
  scenes: StitchScene[],
  config: { width: number; height: number; fps: number }
): AsyncGenerator<EncodedVideoChunk>
```

Logic:
- For each scene:
  1. If showChapterCard: yield title card frames
  2. Decode composed.mp4 → yield video frames (re-encode if needed)
- Track cumulative timeline offset for audio placement

### 6. Render pipeline (`src/lib/video/renderPipeline.ts`)

Final orchestration:
```ts
export async function renderFinalVideo(config: {
  scenes: Array<{
    sceneId: string;
    composedPath: string;
    voiceoverPath: string;
    title: string;
    description: string;
    showChapterCard: boolean;
  }>;
  outputPath: string;
  width?: number;   // 1280
  height?: number;  // 800
  fps?: number;     // 30
}): Promise<{ durationMs: number }>
```

Steps:
1. Calculate timeline: for each scene, compute start offset (accounting for chapter cards)
2. Stitch video: chapter cards + composed scenes → encoded video chunks
3. Process audio: decode each voiceover MP3, place on timeline, mix, encode to AAC
4. Mux: feed video chunks + audio chunks to mediabunny → write output MP4
5. Report progress via callback

### 7. `renderVideo` tool (`src/agent/tools/render.ts`)

```ts
export const renderVideo = tool({
  description: 'Stitch all scenes with chapter cards and voiceover into the final MP4',
  parameters: z.object({
    includeChapterCards: z.boolean().default(true),
  }),
  execute: async ({ includeChapterCards }) => {
    const scenes = project.getScenes();   // get all scene metadata
    const result = await renderFinalVideo({
      scenes: scenes.map(s => ({
        sceneId: s.id,
        composedPath: path.join(project.getSceneDir(s.id), 'composed.mp4'),
        voiceoverPath: path.join(project.getSceneDir(s.id), 'voiceover.mp3'),
        title: s.title,
        description: s.description,
        showChapterCard: s.showChapterCard && includeChapterCards,
      })),
      outputPath: path.join(project.projectDir, 'output', 'final.mp4'),
    });
    return { outputPath: result.outputPath, durationMs: result.durationMs };
  },
});
```

### 8. Video player component (`src/components/preview/VideoPlayer.tsx`)

Simple HTML5 video player:
- Loads local MP4 file via `file://` protocol
- Play/pause, seek bar, volume, fullscreen
- Used in chat attachments and preview panel
- Style: dark theme, minimal controls

**Critical notes:**
- Audio processing must happen in renderer (WebCodecs AudioEncoder needs browser context)
- mediabunny must handle interleaved video + audio tracks
- The timeline calculation is crucial: chapter card duration + scene duration → determines where each voiceover clip starts
- If a scene has no voiceover yet, skip its audio (render video-only for that scene)

After implementation:
1. Have 2-3 recorded + composed + voiced scenes
2. Call renderVideo → final.mp4 exists
3. Play: chapter cards → scene 1 with voiceover → chapter card → scene 2 with voiceover → ...
4. Voiceover is in sync with the visuals
5. Video plays in QuickTime, VLC, and the in-app player
```
