// ── Artifact probes ──────────────────────────────────────────────────────────
//
// Runs the ffmpeg passes whose output artifact-pure.cjs parses. These run on
// the RAW scene recording, before sync: the retimer inserts freeze-holds on
// purpose, so probing the retimed file would flag intended output as a defect.
//
// One ffmpeg run answers black-frame AND audio-presence, because the filter
// pass's stderr also carries the input's `Stream #0:N:` lines. There is no
// ffprobe in this project.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { resolveFfmpeg } from "../../lib/ffmpeg"
import { probeDurationSec } from "../lib/media-probe"

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

export interface BlackSpan {
  startSec: number
  endSec: number
  durationSec: number
}
export interface FreezeSpan {
  startSec: number
  durationSec: number
  /** True when the freeze had not resolved by the time the recording ended. */
  open?: boolean
}

const pure = require("./artifact-pure.cjs") as {
  parseBlackDetect: (stderr: string) => BlackSpan[]
  parseFreezeDetect: (stderr: string) => FreezeSpan[]
  hasAudioStream: (ffmpegStderr: string) => boolean
}

export interface ArtifactProbe {
  durationSec: number
  blackSpans: BlackSpan[]
  freezeSpans: FreezeSpan[]
  hasAudio: boolean
}

/**
 * ffmpeg writes filter findings to stderr and exits 0, but a decode failure
 * exits non-zero. `execFile` rejects on non-zero, and the rejection still
 * carries stderr — so read it off the error rather than losing the findings.
 */
async function runFilter(
  ffmpeg: string,
  videoPath: string,
  filter: string
): Promise<string> {
  try {
    const { stderr } = await execFileAsync(ffmpeg, [
      "-hide_banner",
      "-i",
      videoPath,
      "-vf",
      filter,
      "-an",
      "-f",
      "null",
      "-",
    ])
    return stderr
  } catch (err) {
    const e = err as { stderr?: string }
    return e.stderr ?? ""
  }
}

export async function probeArtifact(videoPath: string): Promise<ArtifactProbe> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error("ffmpeg binary not available — cannot probe the recording.")
  }

  const durationSec = await probeDurationSec(videoPath)

  const blackStderr = await runFilter(
    ffmpeg,
    videoPath,
    "blackdetect=d=0.5:pix_th=0.10"
  )
  // d=4 deliberately: a deterministic replay dwells on a settled page for
  // seconds at a time, which is a static image but not a defect. Only a
  // freeze longer than any intended dwell is worth surfacing.
  const freezeStderr = await runFilter(
    ffmpeg,
    videoPath,
    "freezedetect=n=-60dB:d=4"
  )

  // The blackdetect pass already dumped the input's stream table to stderr,
  // so audio presence is free — no second spawn, no ffprobe.
  return {
    durationSec,
    blackSpans: pure.parseBlackDetect(blackStderr),
    freezeSpans: pure.parseFreezeDetect(freezeStderr),
    hasAudio: pure.hasAudioStream(blackStderr),
  }
}

/**
 * Peak level of the audio, in dB — null when it cannot be measured.
 *
 * "Has an audio stream" cannot tell a voiced video from a silent one here:
 * every scene file is muxed with a silent AAC track so the final concat can
 * stream-copy. Digital silence peaks at about -91 dB; speech is nowhere near.
 */
export async function peakVolumeDb(videoPath: string): Promise<number | null> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) return null
  let stderr = ""
  try {
    ;({ stderr } = await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-i",
        videoPath,
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { timeout: 120_000 }
    ))
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? ""
  }
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)
  if (!m) return null
  return m[1] === "-inf" ? -Infinity : Number(m[1])
}
