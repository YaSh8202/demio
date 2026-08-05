// ── Voiceover synthesis (pure) ───────────────────────────────────────────────
//
// ElevenLabs text-to-speech synthesis for a scene's narration.
// `synthesizeNarrationAudio` is synthesis-only: it writes each text's MP3 and
// probes its real duration, with no opinion on placement. Timing is the EDL
// builder's job (`edl-pure.cjs`) and mixing is `sync.ts`'s — this module
// does neither.
//
// Pure with respect to the agent runtime: no `ai` tool wrapper, no zod, no
// tool-result shaping. Still does real I/O (network fetch, file writes,
// ffmpeg probe) — this is "pure" in the sense of "reusable outside a tool",
// not side-effect-free.

import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import log from "../../lib/logger"
import { resolveFfmpeg } from "../../lib/ffmpeg"

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
const DEFAULT_MODEL = "eleven_turbo_v2_5"
const OUTPUT_FORMAT = "mp3_44100_128"

export type VoiceoverSynthesisFailureReason =
  | "aborted"
  | "network"
  | "elevenlabs_error"
  | "probe_failed"

/**
 * Thrown by `synthesizeNarrationAudio` on any failure. Carries
 * `reason`/`message` plus how many texts had already synthesized
 * successfully before the failure, for partial-progress reporting.
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
 * produce a parseable `Duration:` line.
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

export interface SynthesizedAudio {
  /** Workspace-relative MP3 path: `scenes/<sceneId>.voice-NN.mp3`. */
  file: string
  durationMs: number
}

/**
 * Synthesize each text via ElevenLabs in order, write
 * `scenes/<sceneId>.voice-NN.mp3`, probe real durations. Placement/mixing is
 * NOT this module's job — the EDL builder (edl-pure.cjs) turns these
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
