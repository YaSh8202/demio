# Phase 08 — Voiceover

## Prerequisites
- Phase 07 (Scene Recording) — scenes recorded with timing data

## Goals
Integrate ElevenLabs TTS to generate voiceover audio for each scene's narration. Handle duration alignment between voiceover and recording. By the end, each scene has a matching `voiceover.mp3` file.

## Tasks

### 8.1 ElevenLabs API wrapper
- `src/lib/elevenlabs.ts`
- Initialize client with API key from config
- `generateSpeech(text: string, voiceId?: string): Promise<{ audioPath: string, durationMs: number }>`
- Save audio to scene directory as `voiceover.mp3`
- Support voice selection (default to a good narration voice)
- Handle rate limits and errors gracefully
- Get audio duration after generation (use AudioContext.decodeAudioData or similar)

### 8.2 Audio duration utility
- `src/lib/audio/duration.ts`
- `getAudioDuration(filePath: string): Promise<number>` — returns duration in ms
- Works with MP3 files from ElevenLabs
- Can use a lightweight approach: read file in renderer's AudioContext, or parse MP3 headers

### 8.3 `generateVoiceover` tool
- `src/agent/tools/voiceover.ts`
- Parameters: `sceneId`, `text` (narration), `voiceId` (optional)
- Execute:
  1. Call ElevenLabs API with the narration text
  2. Save audio to `<sceneDir>/voiceover.mp3`
  3. Get duration of generated audio
  4. Compare with scene recording duration (from timing data)
  5. Return `{ sceneId, audioPath, audioDurationMs, recordingDurationMs, aligned: boolean }`

### 8.4 Duration alignment logic
- After generating voiceover, check if durations match:
  - **voiceover > recording**: the video is too short for the narration
    - Agent should add more `wait` steps to the record.sh and re-record
    - Or the compose phase can pad with freeze-frame (handled in Phase 10)
  - **voiceover < recording**: acceptable — silence fills the gap naturally
  - **Tolerance**: ±500ms is fine
- The tool returns `aligned: boolean` and a suggestion if misaligned
- Agent decides whether to re-record or proceed

### 8.5 Voice selection
- `src/lib/elevenlabs.ts` — function to list available voices
- Default voice: pick a clear, professional narration voice
- Allow user to specify voice via project settings or chat instruction
- Store selected voiceId in project state

### 8.6 API key configuration
- `src/lib/config.ts` — add `ELEVENLABS_API_KEY` alongside the Anthropic key
- Agent should check for the key before attempting voiceover
- If missing, use `askUser` to request it

### 8.7 Register tool in orchestrator
- Add `generate_voiceover` to tools in `src/agent/orchestrator.ts`

### 8.8 Voiceover progress in chat
- ProgressCard variant for voiceover generation
- Shows: scene name, narration text preview, generation status
- On complete: shows duration and alignment status
- Optional: audio preview player in chat (play the generated audio)

## Files to Create/Modify

```
src/lib/elevenlabs.ts                # ElevenLabs API wrapper
src/lib/audio/duration.ts            # Audio duration utility
src/agent/tools/voiceover.ts          # generateVoiceover tool
src/agent/orchestrator.ts             # Register tool
src/lib/config.ts                     # Add ElevenLabs key
src/lib/project.ts                    # Store voiceId selection
```

## Verification
1. Set `ELEVENLABS_API_KEY` env var
2. Agent generates voiceover for a scene: `generateVoiceover({ sceneId: "scene-01", text: "Let's create..." })`
3. `voiceover.mp3` exists in scene directory
4. Audio plays correctly, spoken text matches narration
5. Duration is reported accurately (within 100ms)
6. Alignment check: agent correctly identifies if voiceover is too long for the recording
7. Multiple voices: can specify different voiceId
8. Error handling: API failure → agent sees error, can retry

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phases 01-07 are complete: the AI agent can browse, generate scripts, and record scenes to WebM with timing data. This is Phase 8: voiceover generation.

**Context:**
- Each scene has: `record.sh` (commands), `raw.webm` (recording), `timing.json` (per-step timestamps)
- Each scene has a `narration` field — the text to be spoken as voiceover
- We use ElevenLabs API for text-to-speech
- The `elevenlabs` npm package is already installed

**Task: Integrate ElevenLabs TTS and build the generateVoiceover tool.**

### 1. ElevenLabs wrapper (`src/lib/elevenlabs.ts`)

```ts
import { ElevenLabsClient } from 'elevenlabs';

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

export async function generateSpeech(
  text: string,
  outputPath: string,
  voiceId?: string
): Promise<{ durationMs: number }> {
  // Use the ElevenLabs SDK to generate speech
  // Default voice: pick a clear narration voice (e.g., "Rachel" or similar)
  // Save the audio to outputPath as MP3
  // Return the duration
}

export async function listVoices(): Promise<Array<{ id: string; name: string }>> {
  // List available voices for selection
}
```

Use the ElevenLabs SDK's `textToSpeech.convert()` or `generate()` method. The audio output is a stream — pipe it to a file. After saving, determine the duration.

### 2. Audio duration (`src/lib/audio/duration.ts`)

```ts
export async function getAudioDuration(filePath: string): Promise<number>
```

Options for getting MP3 duration:
- Parse MP3 frames to calculate duration (lightweight, no external dep)
- Use `music-metadata` npm package if available
- Or decode in Electron's renderer AudioContext (but we're in main process)

Recommended: parse the MP3 file header. For a simpler approach, you can use the `music-metadata` package or calculate from file size + bitrate if ElevenLabs returns CBR audio.

### 3. `generateVoiceover` tool (`src/agent/tools/voiceover.ts`)

```ts
export const generateVoiceover = tool({
  description: 'Generate AI voiceover audio for a scene narration using ElevenLabs TTS',
  parameters: z.object({
    sceneId: z.string(),
    text: z.string().describe('Narration text to speak'),
    voiceId: z.string().optional().describe('ElevenLabs voice ID (defaults to standard narration voice)'),
  }),
  execute: async ({ sceneId, text, voiceId }) => {
    const sceneDir = project.getSceneDir(sceneId);
    const audioPath = path.join(sceneDir, 'voiceover.mp3');
    
    const { durationMs: audioDurationMs } = await generateSpeech(text, audioPath, voiceId);
    
    // Get recording duration from timing data
    const timingPath = path.join(sceneDir, 'timing.json');
    const timing = JSON.parse(await fs.readFile(timingPath, 'utf-8'));
    const recordingDurationMs = timing[timing.length - 1]?.timeMs ?? 0;
    
    const aligned = Math.abs(audioDurationMs - recordingDurationMs) < 2000;
    
    return {
      sceneId,
      audioPath,
      audioDurationMs,
      recordingDurationMs,
      aligned,
      suggestion: !aligned && audioDurationMs > recordingDurationMs
        ? `Voiceover is ${((audioDurationMs - recordingDurationMs) / 1000).toFixed(1)}s longer than recording. Consider adding wait steps to the recording script.`
        : undefined,
    };
  },
});
```

### 4. API key handling

In `src/lib/config.ts`:
- Add `ELEVENLABS_API_KEY` check
- If the key is missing when `generateVoiceover` is called, return an error suggesting the agent ask the user for the key

### 5. Register in orchestrator

Add `generate_voiceover` to tools in `src/agent/orchestrator.ts`.

**Important notes:**
- ElevenLabs returns MP3 audio — save directly, no conversion needed yet (AAC conversion happens during final render)
- The agent should generate voiceover for ALL scenes, then check duration alignment across all
- If voiceover is much longer than recording, the agent should fix the script and re-record before proceeding
- Voice selection: default to a good male or female narration voice. The agent can ask the user for preference.

After implementation:
1. Set ELEVENLABS_API_KEY, have a recorded scene from Phase 7
2. Agent calls generateVoiceover for a scene
3. voiceover.mp3 appears in the scene directory
4. Audio quality is good, matches narration text
5. Duration alignment check works correctly
6. Agent handles the case where audio is too long (suggests re-recording with more pauses)
```
