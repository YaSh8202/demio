// ── Voiceover Tool ──────────────────────────────────────────────────────────
//
// Synthesises ElevenLabs voiceover for a single scene as one or more timed
// segments. The agent reads `scenes/scene-NN.actions.jsonl` to learn when
// actions happen, then schedules segments with `startTimeSec` relative to the
// scene's recording start.
//
// The tool writes one MP3 per segment to `scenes/<sceneId>.voice-<NN>.mp3`,
// probes each duration via ffmpeg, and returns a ready-to-run ffmpeg
// `filter_complex` command the agent can pipe through the `terminal` tool to
// overlay segments onto the scene and produce `scenes/<sceneId>.voiced.mp4`.
//
// Composition stays with `terminal` — this tool is pure synthesis + planning.
// The actual synthesis (ElevenLabs fetch, per-segment MP3 write, ffprobe
// duration validation, non-overlap check, mix-args construction) lives in
// `agent/lib/voiceover.ts` — reused as-is by the tts workflow step (Task 12).
// This file is now schema + delegation + result formatting only.

import { tool } from "ai"
import { z } from "zod"
import {
  synthesizeSegments,
  VoiceoverSynthesisError,
  type SynthesizedSegmentDetail,
} from "../lib/voiceover"

export interface VoiceoverToolOptions {
  cwd: string
  voiceId: string
  apiKey: string
  signal: AbortSignal
}

/**
 * Turn the lib's execFile-safe `ffmpegMixArgs` into the single ready-to-run
 * shell command string the tool has always returned. Built by
 * quoting/joining that exact array — one source of truth, so the string and
 * the args it was derived from can never drift apart. The `terminal` tool
 * always runs with `cwd` == the workspace (see `workspace-factory.ts`), so
 * the workspace-relative paths inside `args` resolve without a `$WORKSPACE`
 * prefix, and `ffmpeg` resolves via the terminal's PATH shim.
 */
function quoteArgForShell(arg: string): string {
  // Bare tokens (flags, plain workspace-relative paths, "0:v", …) need no
  // quoting. Anything with shell metacharacters — notably the
  // filter_complex value and "[aout]" — gets double-quoted.
  if (/^[A-Za-z0-9_.\-:/]+$/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

function buildFfmpegMixCommand(ffmpegMixArgs: string[]): string {
  return ["ffmpeg", ...ffmpegMixArgs.map(quoteArgForShell)].join(" ")
}

const TOOL_DESCRIPTION = `Synthesise voiceover narration for one scene using ElevenLabs.

You must call this tool AFTER the scene has been recorded. Plan the segments by:
1. Reading scenes/<sceneId>.actions.jsonl (each line has tsMs since record start).
2. Picking concise narration lines (target ~150 wpm).
3. Setting each segment's \`startTimeSec\` so the line lands near the action it describes — usually slightly before the click/fill it narrates.

The tool writes one MP3 per segment to scenes/<sceneId>.voice-NN.mp3, validates that segments do not overlap (segment N+1 must start AFTER segment N ends), and returns:
- \`segmentFiles\`: each segment's workspace-relative MP3 path, startTimeSec, and actual durationSec.
- \`ffmpegMixCommand\`: a ready-to-run ffmpeg invocation. Pass it through the \`terminal\` tool to produce scenes/<sceneId>.voiced.mp4 (video + mixed audio). In phase 5 (Composition) concat the .voiced.mp4 files instead of the raw .webm.

If the tool returns ok:false with reason "overlap", shorten or re-time the offending segments and call again. Segments must be in startTimeSec order.`

export function createVoiceoverTool({
  cwd,
  voiceId,
  apiKey,
  signal,
}: VoiceoverToolOptions) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({
      sceneId: z
        .string()
        .regex(/^[a-zA-Z0-9._-]+$/, "sceneId must be a safe filename slug")
        .describe(
          "Scene identifier matching the recorded file (e.g. 'scene-01' for scenes/scene-01.webm)"
        ),
      segments: z
        .array(
          z.object({
            text: z
              .string()
              .min(1)
              .max(800)
              .describe(
                "Voiceover line to synthesize. Keep concise — target ~150 wpm."
              ),
            startTimeSec: z
              .number()
              .min(0)
              .describe(
                "When this segment starts, in seconds relative to the scene's recording start."
              ),
          })
        )
        .min(1)
        .max(20)
        .describe("Ordered narration segments for this scene."),
    }),

    execute: async ({ sceneId, segments }) => {
      const synthesized: SynthesizedSegmentDetail[] = []

      try {
        const result = await synthesizeSegments({
          cwd,
          sceneId,
          sceneVideoPath: `scenes/${sceneId}.webm`,
          segments: segments.map((s) => ({
            text: s.text,
            atSec: s.startTimeSec,
          })),
          voiceId,
          apiKey,
          signal,
          onSegment: (detail) => synthesized.push(detail),
        })

        const ffmpegMixCommand = buildFfmpegMixCommand(result.ffmpegMixArgs)

        return {
          ok: true,
          sceneId,
          segmentFiles: synthesized,
          ffmpegMixCommand,
          notes:
            "Run ffmpegMixCommand via the `terminal` tool to produce scenes/" +
            sceneId +
            ".voiced.mp4. In phase 5 concat .voiced.mp4 files instead of .webm.",
        }
      } catch (err) {
        if (err instanceof VoiceoverSynthesisError) {
          return {
            ok: false,
            reason: err.reason,
            message: err.message,
            segmentFiles: err.segments,
          }
        }
        throw err
      }
    },
  })
}
