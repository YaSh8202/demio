// ── Voiceover synthesis (pure) ───────────────────────────────────────────────
//
// ElevenLabs text-to-speech synthesis for a scene's narration segments, plus
// the ffmpeg mix-args construction that overlays them onto the scene video.
// Extracted from `agent/tools/voiceover.ts` so the tts workflow step (Task
// 12) can call it directly without going through the tool/agent loop.
//
// Pure with respect to the agent runtime: no `ai` tool wrapper, no zod, no
// tool-result shaping. Still does real I/O (network fetch, file writes,
// ffmpeg probe) — this is "pure" in the sense of "reusable outside a tool",
// not side-effect-free.

import { spawn } from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import log from "../../lib/logger"
import { resolveFfmpeg } from "../../lib/ffmpeg"

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
const DEFAULT_MODEL = "eleven_turbo_v2_5"
const OUTPUT_FORMAT = "mp3_44100_128"

export interface VoiceSegment {
  text: string
  atSec: number
}

export interface SynthesizedVoiceover {
  /** Workspace-relative (relative to `opts.cwd`) MP3 path per segment, in
   * `atSec` order. */
  segmentPaths: string[]
  /** execFile-safe argv for the ffmpeg mix (no shell involved — each flag
   * and value is its own element; paths are workspace-relative, resolve
   * against `opts.cwd`). */
  ffmpegMixArgs: string[]
  /** Workspace-relative output path: `scenes/<sceneId>.voiced.mp4`. */
  outputPath: string
}

/** Per-segment detail: what `tools/voiceover.ts` reports back to the agent.
 * Not part of the locked `SynthesizedVoiceover` return shape (Task 12 only
 * needs paths/args), but callers that want it can collect it via
 * `opts.onSegment`, and it's what `VoiceoverSynthesisError.segments` carries
 * on failure. */
export interface SynthesizedSegmentDetail {
  file: string
  startTimeSec: number
  durationSec: number
}

export type VoiceoverSynthesisFailureReason =
  | "aborted"
  | "network"
  | "elevenlabs_error"
  | "probe_failed"
  | "overlap"

/**
 * Thrown by `synthesizeSegments` on any failure. Carries the same
 * `reason` / `message` / partial-segment-detail shape the tool used to
 * return directly (pre-extraction), so `tools/voiceover.ts` can catch this
 * and reformat an identical `ok: false` result.
 */
export class VoiceoverSynthesisError extends Error {
  readonly reason: VoiceoverSynthesisFailureReason
  readonly segments: SynthesizedSegmentDetail[]

  constructor(
    reason: VoiceoverSynthesisFailureReason,
    message: string,
    segments: SynthesizedSegmentDetail[]
  ) {
    super(message)
    this.name = "VoiceoverSynthesisError"
    this.reason = reason
    this.segments = segments
  }
}

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
  const bin = resolveFfmpeg()
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
 * Build execFile-safe ffmpeg args to overlay each segment onto the scene
 * video and produce `<sceneId>.voiced.mp4`. Every path is workspace-relative
 * (relative to `cwd`) — callers resolve them, either by passing `cwd` to
 * `execFile`, or (as `tools/voiceover.ts` does) by prefixing them for a
 * shell string. Segments are delayed with `adelay` (ms) and mixed with
 * `amix`. `-shortest` is intentionally omitted — callers should keep the
 * full scene.
 */
function buildFfmpegMixArgs(
  sceneVideoPath: string,
  outputPath: string,
  segments: Array<{ file: string; startTimeSec: number }>
): string[] {
  const args: string[] = ["-y", "-i", sceneVideoPath]
  for (const seg of segments) {
    args.push("-i", seg.file)
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

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "aac",
    outputPath
  )
  return args
}

/**
 * Synthesise every segment via ElevenLabs, write one MP3 each to
 * `scenes/<sceneId>.voice-NN.mp3`, probe durations, validate no overlap, and
 * build the ffmpeg mix args to produce `scenes/<sceneId>.voiced.mp4`.
 *
 * Throws `VoiceoverSynthesisError` on any failure (network, ElevenLabs
 * error, probe failure, overlap, or abort) — callers that need to report
 * partial progress (e.g. the tool) read `err.segments`.
 */
export async function synthesizeSegments(opts: {
  cwd: string
  sceneId: string
  sceneVideoPath: string
  segments: VoiceSegment[]
  voiceId: string
  apiKey: string
  signal?: AbortSignal
  /**
   * Optional per-segment callback, fired immediately after each segment's
   * MP3 is written and its duration probed. Additive to the locked
   * interface (Task 12 callers can omit it) — `tools/voiceover.ts` uses it
   * to recover the startTimeSec/durationSec detail its documented result
   * reports, without a second probe pass over files this function already
   * probed once for the overlap check.
   */
  onSegment?: (detail: SynthesizedSegmentDetail) => void
}): Promise<SynthesizedVoiceover> {
  const { cwd, sceneId, sceneVideoPath, voiceId, apiKey, signal, onSegment } =
    opts

  // Sort defensively in case the caller didn't.
  const sorted = [...opts.segments].sort((a, b) => a.atSec - b.atSec)

  const scenesDir = path.join(cwd, "scenes")
  await fsPromises.mkdir(scenesDir, { recursive: true })

  const synthesized: SynthesizedSegmentDetail[] = []

  for (let i = 0; i < sorted.length; i++) {
    if (signal?.aborted) {
      throw new VoiceoverSynthesisError(
        "aborted",
        "Stopped by user before all segments synthesised",
        synthesized
      )
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
      if (signal?.aborted) {
        throw new VoiceoverSynthesisError(
          "aborted",
          "Stopped by user during synthesis",
          synthesized
        )
      }
      log.error(`[voiceover] fetch failed for segment ${idx}:`, err)
      throw new VoiceoverSynthesisError(
        "network",
        err instanceof Error ? err.message : String(err),
        synthesized
      )
    }

    if (!res.ok) {
      let body = ""
      try {
        body = (await res.text()).slice(0, 500)
      } catch {
        /* ignore */
      }
      throw new VoiceoverSynthesisError(
        "elevenlabs_error",
        `ElevenLabs returned ${res.status} for segment ${idx}: ${body}`,
        synthesized
      )
    }

    const buf = Buffer.from(await res.arrayBuffer())
    await fsPromises.writeFile(tmp, buf)
    await fsPromises.rename(tmp, abs)

    const duration = await probeDurationSec(abs)
    if (duration === null) {
      throw new VoiceoverSynthesisError(
        "probe_failed",
        `Could not read duration of ${rel} via ffmpeg.`,
        synthesized
      )
    }

    const detail: SynthesizedSegmentDetail = {
      file: rel,
      startTimeSec: seg.atSec,
      durationSec: Number(duration.toFixed(3)),
    }
    synthesized.push(detail)
    onSegment?.(detail)
  }

  // Overlap check (after all durations are known)
  for (let i = 0; i < synthesized.length - 1; i++) {
    const cur = synthesized[i]
    const next = synthesized[i + 1]
    const endOfCur = cur.startTimeSec + cur.durationSec
    if (endOfCur > next.startTimeSec + 1e-3) {
      throw new VoiceoverSynthesisError(
        "overlap",
        `Segment ${i + 1} ends at ${endOfCur.toFixed(2)}s but segment ${i + 2} starts at ${next.startTimeSec.toFixed(2)}s. Shorten segment ${i + 1} or push segment ${i + 2} later, then re-call.`,
        synthesized
      )
    }
  }

  const outputPath = `scenes/${sceneId}.voiced.mp4`
  const ffmpegMixArgs = buildFfmpegMixArgs(sceneVideoPath, outputPath, synthesized)

  return {
    segmentPaths: synthesized.map((s) => s.file),
    ffmpegMixArgs,
    outputPath,
  }
}
