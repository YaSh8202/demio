// ── Voiceover synthesis (pure) ───────────────────────────────────────────────
//
// ElevenLabs text-to-speech synthesis for a scene's narration. Two APIs
// currently live here side by side:
//
// - `synthesizeSegments` (legacy) also builds the ffmpeg mix-args that
//   overlay timed segments onto the scene video. Extracted from
//   `agent/tools/voiceover.ts` so the tts workflow step could call it
//   directly without going through the tool/agent loop. `demo-video.ts`'s
//   `ttsStep` still calls this until Task 6 rewires it onto the EDL-based
//   sync engine, at which point this function (and `buildFfmpegMixArgs`) are
//   deleted.
// - `synthesizeNarrationAudio` (new, Task 4) is synthesis-only: it writes
//   each text's MP3 and probes its real duration, with no opinion on
//   placement. Timing is the EDL builder's job (`edl-pure.cjs`) and mixing
//   is `sync.ts`'s — this module no longer does either.
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
 * Thrown by `synthesizeSegments`/`synthesizeNarrationAudio` on any failure.
 * Carries `reason`/`message` plus how many segments/texts had already
 * synthesized successfully before the failure, for partial-progress
 * reporting.
 *
 * `"overlap"` is only ever thrown by `synthesizeSegments` (kept in the union
 * until Task 6 deletes that function) — `synthesizeNarrationAudio` never
 * throws it, since it has no opinion on placement.
 */
export class VoiceoverSynthesisError extends Error {
  readonly reason: VoiceoverSynthesisFailureReason
  readonly synthesizedCount: number

  constructor(
    reason: VoiceoverSynthesisFailureReason,
    message: string,
    synthesizedCount: number
  ) {
    super(message)
    this.name = "VoiceoverSynthesisError"
    this.reason = reason
    this.synthesizedCount = synthesizedCount
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
    // Pin the audio format explicitly (code review round-2 #5, Task 12)
    // rather than relying on `amix`'s implicit output format (which follows
    // its first input — normally 44100/mono-or-stereo per segment, but not
    // guaranteed if a future caller feeds it something else). The
    // demo-video workflow's `composeStep` concatenates this output via
    // stream copy (`-c copy`) alongside other parts pinned to the same
    // 44100/stereo format — any divergence here would only surface as a
    // broken/silent-audio concat downstream, not as an error at this step.
    "-ar",
    "44100",
    "-ac",
    "2",
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
        synthesized.length
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
          synthesized.length
        )
      }
      log.error(`[voiceover] fetch failed for segment ${idx}:`, err)
      throw new VoiceoverSynthesisError(
        "network",
        err instanceof Error ? err.message : String(err),
        synthesized.length
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
        synthesized.length
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
        synthesized.length
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

  // Scene-end clamp (after all durations are known): the narrator places
  // segments against its own duration estimate, and the mix truncates audio
  // at the video's end — a segment whose tail crosses scene end gets cut
  // mid-word (observed live: "no later than durationSec - 2" placement vs
  // 2.5-3.8s segments). Walk backwards shifting late segments earlier so
  // every tail lands ≥ TAIL_MARGIN before the video ends, cascading so a
  // shifted segment cannot collide with the one before it. `onSegment` has
  // already fired with pre-clamp times; shifts are logged and the returned
  // mix args use the clamped times.
  const sceneVideoAbs = path.isAbsolute(sceneVideoPath)
    ? sceneVideoPath
    : path.join(cwd, sceneVideoPath)
  const sceneDur = await probeDurationSec(sceneVideoAbs)
  if (sceneDur !== null) {
    const TAIL_MARGIN = 0.3
    const GAP = 0.15
    let latestAllowedEnd = sceneDur - TAIL_MARGIN
    for (let i = synthesized.length - 1; i >= 0; i--) {
      const s = synthesized[i]
      const end = s.startTimeSec + s.durationSec
      if (end > latestAllowedEnd) {
        const newStart = Math.max(0, latestAllowedEnd - s.durationSec)
        log.warn(
          `[voiceover] segment ${i + 1} would end at ${end.toFixed(2)}s past scene end ` +
            `${sceneDur.toFixed(2)}s — shifted start ${s.startTimeSec.toFixed(2)}s → ${newStart.toFixed(2)}s`
        )
        s.startTimeSec = Number(newStart.toFixed(3))
      }
      latestAllowedEnd = s.startTimeSec - GAP
    }
  }

  // Overlap check (after all durations are known and ends are clamped) —
  // still throws when total speech simply cannot fit inside the scene.
  for (let i = 0; i < synthesized.length - 1; i++) {
    const cur = synthesized[i]
    const next = synthesized[i + 1]
    const endOfCur = cur.startTimeSec + cur.durationSec
    if (endOfCur > next.startTimeSec + 1e-3) {
      throw new VoiceoverSynthesisError(
        "overlap",
        `Segment ${i + 1} ends at ${endOfCur.toFixed(2)}s but segment ${i + 2} starts at ${next.startTimeSec.toFixed(2)}s. Shorten segment ${i + 1} or push segment ${i + 2} later, then re-call.`,
        synthesized.length
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

export interface SynthesizedAudio {
  /** Workspace-relative MP3 path: `scenes/<sceneId>.voice-NN.mp3`. */
  file: string
  durationMs: number
}

/**
 * Synthesize each text via ElevenLabs in order, write
 * `scenes/<sceneId>.voice-NN.mp3`, probe real durations. Placement/mixing is
 * NOT this module's job anymore — the EDL builder (edl-pure.cjs) turns these
 * durations into timeline offsets and sync.ts mixes them.
 */
export async function synthesizeNarrationAudio(opts: {
  cwd: string
  sceneId: string
  texts: string[]
  voiceId: string
  apiKey: string
  signal?: AbortSignal
}): Promise<SynthesizedAudio[]> {
  const { cwd, sceneId, texts, voiceId, apiKey, signal } = opts
  const scenesDir = path.join(cwd, "scenes")
  await fsPromises.mkdir(scenesDir, { recursive: true })

  const out: SynthesizedAudio[] = []
  for (let i = 0; i < texts.length; i++) {
    if (signal?.aborted) {
      throw new VoiceoverSynthesisError(
        "aborted",
        "Stopped by user before all segments synthesised",
        out.length
      )
    }
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
            text: texts[i],
            model_id: DEFAULT_MODEL,
          }),
        }
      )
    } catch (err) {
      if (signal?.aborted) {
        throw new VoiceoverSynthesisError(
          "aborted",
          "Stopped by user during synthesis",
          out.length
        )
      }
      log.error(`[voiceover] fetch failed for segment ${idx}:`, err)
      throw new VoiceoverSynthesisError(
        "network",
        err instanceof Error ? err.message : String(err),
        out.length
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
        out.length
      )
    }

    const buf = Buffer.from(await res.arrayBuffer())
    await fsPromises.writeFile(tmp, buf)
    await fsPromises.rename(tmp, abs)

    const durationSec = await probeDurationSec(abs)
    if (durationSec === null) {
      throw new VoiceoverSynthesisError(
        "probe_failed",
        `Could not read duration of ${rel} via ffmpeg.`,
        out.length
      )
    }
    out.push({ file: rel, durationMs: Math.round(durationSec * 1000) })
  }
  return out
}
