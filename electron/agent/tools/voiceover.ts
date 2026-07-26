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

import { spawn } from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import { tool } from "ai"
import { z } from "zod"
import log from "../../lib/logger"
import { resolveFfmpeg } from "../../lib/ffmpeg"

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
const DEFAULT_MODEL = "eleven_turbo_v2_5"
const OUTPUT_FORMAT = "mp3_44100_128"

export interface VoiceoverToolOptions {
  cwd: string
  voiceId: string
  apiKey: string
  signal: AbortSignal
}

const resolveFfmpegPath = resolveFfmpeg

/**
 * Estimate MP3 duration from file size for a fixed-bitrate stream.
 * `mp3_44100_128` = 128 kbps = 16,000 bytes/sec. Accurate within ~50ms (ID3
 * tag overhead ≲ 1KB). Used as a fallback when ffmpeg's stderr probe doesn't
 * produce a parseable `Duration:` line — good enough for overlap validation
 * and the agent can ffprobe later if it needs exact timing.
 */
function estimateMp3Duration128kbps(filePath: string): number | null {
  try {
    const { size } = fs.statSync(filePath)
    if (size < 200) return null
    return Math.max(0, (size - 200) / 16000)
  } catch {
    return null
  }
}

/**
 * Read the MP3 duration. Tries ffmpeg first; falls back to size-based
 * estimation for the fixed 128 kbps output format we request. Logs the
 * ffmpeg stderr when both paths fail so we can debug the binary.
 */
async function probeDurationSec(filePath: string): Promise<number | null> {
  const bin = resolveFfmpegPath()
  if (bin && fs.existsSync(bin)) {
    const fromFfmpeg = await new Promise<number | null>((resolve) => {
      let stderr = ""
      let settled = false
      const settle = (v: number | null) => {
        if (settled) return
        settled = true
        resolve(v)
      }
      try {
        const child = spawn(bin, [
          "-hide_banner",
          "-i",
          filePath,
          "-f",
          "null",
          "-",
        ])
        child.stderr.on("data", (b: Buffer) => {
          stderr += b.toString()
        })
        child.on("close", () => {
          const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
          if (!m) {
            log.warn(
              `[voiceover] ffmpeg probe did not return Duration for ${filePath}. stderr: ${stderr.slice(0, 400)}`
            )
            return settle(null)
          }
          const h = Number(m[1])
          const min = Number(m[2])
          const s = Number(m[3])
          settle(h * 3600 + min * 60 + s)
        })
        child.on("error", (err) => {
          log.warn(`[voiceover] ffmpeg spawn error: ${err.message}`)
          settle(null)
        })
      } catch (err) {
        log.warn(
          `[voiceover] ffmpeg spawn threw: ${err instanceof Error ? err.message : String(err)}`
        )
        settle(null)
      }
    })
    if (fromFfmpeg !== null) return fromFfmpeg
  } else {
    log.warn(
      `[voiceover] ffmpeg binary not found at ${bin ?? "(null)"} — falling back to file-size estimate`
    )
  }
  // Fallback: estimate from file size at the known 128 kbps output bitrate.
  return estimateMp3Duration128kbps(filePath)
}

/**
 * Build the ffmpeg command the agent should run via the `terminal` tool to
 * overlay each segment onto the scene's webm and produce a `.voiced.mp4`.
 * Segments are delayed with `adelay` (ms) and mixed with `amix`. The output
 * `-shortest` is intentionally omitted — the agent should keep the full scene.
 */
function buildFfmpegMixCommand(
  cwd: string,
  sceneId: string,
  segments: Array<{ file: string; startTimeSec: number }>
): string {
  const sceneVideo = `$WORKSPACE/scenes/${sceneId}.webm`
  const out = `$WORKSPACE/scenes/${sceneId}.voiced.mp4`

  const inputs: string[] = [`-i ${sceneVideo}`]
  for (const seg of segments) {
    const abs = path.isAbsolute(seg.file)
      ? seg.file
      : `$WORKSPACE/${path.relative(cwd, path.join(cwd, seg.file))}`
    inputs.push(`-i ${abs}`)
  }

  const filterParts: string[] = []
  const labels: string[] = []
  segments.forEach((seg, i) => {
    const delayMs = Math.max(0, Math.round(seg.startTimeSec * 1000))
    // adelay with same value twice covers stereo (left|right).
    filterParts.push(`[${i + 1}:a]adelay=${delayMs}|${delayMs}[a${i}]`)
    labels.push(`[a${i}]`)
  })
  filterParts.push(
    `${labels.join("")}amix=inputs=${segments.length}:dropout_transition=0[aout]`
  )
  const filter = filterParts.join(";")

  return [
    `ffmpeg -y`,
    ...inputs,
    `-filter_complex "${filter}"`,
    `-map 0:v -map "[aout]"`,
    `-c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac`,
    out,
  ].join(" \\\n  ")
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
      // Sort defensively in case the agent didn't.
      const sorted = [...segments].sort(
        (a, b) => a.startTimeSec - b.startTimeSec
      )

      const scenesDir = path.join(cwd, "scenes")
      await fsPromises.mkdir(scenesDir, { recursive: true })

      const synthesized: Array<{
        file: string
        startTimeSec: number
        durationSec: number
      }> = []

      for (let i = 0; i < sorted.length; i++) {
        if (signal.aborted) {
          return {
            ok: false,
            reason: "aborted",
            message: "Stopped by user before all segments synthesised",
            segmentFiles: synthesized,
          }
        }

        const seg = sorted[i]
        const idx = String(i + 1).padStart(2, "0")
        const rel = `scenes/${sceneId}.voice-${idx}.mp3`
        const abs = path.join(cwd, rel)
        const tmp = `${abs}.partial`

        let res: Response
        try {
          res = await fetch(
            `${ELEVENLABS_BASE}/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
            {
              method: "POST",
              signal,
              headers: {
                "xi-api-key": apiKey,
                "content-type": "application/json",
                accept: "audio/mpeg",
              },
              body: JSON.stringify({
                text: seg.text,
                model_id: DEFAULT_MODEL,
              }),
            }
          )
        } catch (err) {
          if (signal.aborted) {
            return {
              ok: false,
              reason: "aborted",
              message: "Stopped by user during synthesis",
              segmentFiles: synthesized,
            }
          }
          log.error(`[voiceover] fetch failed for segment ${idx}:`, err)
          return {
            ok: false,
            reason: "network",
            message: err instanceof Error ? err.message : String(err),
            segmentFiles: synthesized,
          }
        }

        if (!res.ok) {
          let body = ""
          try {
            body = (await res.text()).slice(0, 500)
          } catch {
            /* ignore */
          }
          return {
            ok: false,
            reason: "elevenlabs_error",
            message: `ElevenLabs returned ${res.status} for segment ${idx}: ${body}`,
            segmentFiles: synthesized,
          }
        }

        const buf = Buffer.from(await res.arrayBuffer())
        await fsPromises.writeFile(tmp, buf)
        await fsPromises.rename(tmp, abs)

        const duration = await probeDurationSec(abs)
        if (duration === null) {
          return {
            ok: false,
            reason: "probe_failed",
            message: `Could not read duration of ${rel} via ffmpeg.`,
            segmentFiles: synthesized,
          }
        }

        synthesized.push({
          file: rel,
          startTimeSec: seg.startTimeSec,
          durationSec: Number(duration.toFixed(3)),
        })
      }

      // Overlap check (after all durations are known)
      for (let i = 0; i < synthesized.length - 1; i++) {
        const cur = synthesized[i]
        const next = synthesized[i + 1]
        const endOfCur = cur.startTimeSec + cur.durationSec
        if (endOfCur > next.startTimeSec + 1e-3) {
          return {
            ok: false,
            reason: "overlap",
            message: `Segment ${i + 1} ends at ${endOfCur.toFixed(2)}s but segment ${i + 2} starts at ${next.startTimeSec.toFixed(2)}s. Shorten segment ${i + 1} or push segment ${i + 2} later, then re-call.`,
            segmentFiles: synthesized,
          }
        }
      }

      const ffmpegMixCommand = buildFfmpegMixCommand(cwd, sceneId, synthesized)

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
    },
  })
}
