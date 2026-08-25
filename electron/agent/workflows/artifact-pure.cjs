// Pure parsers for the artifact-level video checks. ffmpeg's blackdetect and
// freezedetect write their findings to stderr as plain text, and the same
// stderr carries the input's `Stream #0:N: Audio:` lines — so one ffmpeg run
// answers all three questions. Parsed here so the shapes are unit-tested
// without spawning anything.
//
// NOTE: this project has no ffprobe, only ffmpeg-static. `probeDurationSec`
// (agent/lib/media-probe.ts) already reads `ffmpeg -i` stderr the same way.
"use strict"

const BLACK_RE =
  /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g
const FREEZE_START_RE = /freeze_start:\s*([\d.]+)/
const FREEZE_DURATION_RE = /freeze_duration:\s*([\d.]+)/

/** Fraction of the recording that may be black before the check fails. */
const MAX_BLACK_FRACTION = 0.5

function parseBlackDetect(stderr) {
  const spans = []
  const text = String(stderr)
  BLACK_RE.lastIndex = 0
  let m
  while ((m = BLACK_RE.exec(text)) !== null) {
    spans.push({
      startSec: Number(m[1]),
      endSec: Number(m[2]),
      durationSec: Number(m[3]),
    })
  }
  return spans
}

/**
 * freezedetect emits start / duration / end as separate lines, so pair them
 * by walking in order: a `freeze_start` opens a span and the next
 * `freeze_duration` closes it.
 */
function parseFreezeDetect(stderr) {
  const spans = []
  let pendingStart = null
  for (const line of String(stderr).split("\n")) {
    const start = line.match(FREEZE_START_RE)
    if (start) {
      pendingStart = Number(start[1])
      continue
    }
    const duration = line.match(FREEZE_DURATION_RE)
    if (duration && pendingStart !== null) {
      spans.push({ startSec: pendingStart, durationSec: Number(duration[1]) })
      pendingStart = null
    }
  }
  return spans
}

const AUDIO_STREAM_RE = /Stream #\d+:\d+.*:\s*Audio:/

function hasAudioStream(ffmpegStderr) {
  return AUDIO_STREAM_RE.test(String(ffmpegStderr))
}

/**
 * Black frames are only fatal when they dominate the take. A brief black
 * span at a navigation boundary is normal; a mostly-black recording is the
 * failure `video-exists` waves through today because the file is non-empty.
 */
function checkBlackFrames(spans, videoDurationSec) {
  const totalSec = spans.reduce((sum, s) => sum + s.durationSec, 0)
  if (spans.length === 0) {
    return { ok: true, detail: "no black frames detected" }
  }
  const ok =
    videoDurationSec <= 0 || totalSec / videoDurationSec <= MAX_BLACK_FRACTION
  return {
    ok,
    detail: ok
      ? `${totalSec.toFixed(2)}s black across ${spans.length} span(s), within tolerance`
      : `${totalSec.toFixed(2)}s of ${videoDurationSec.toFixed(2)}s is black`,
  }
}

/**
 * Replay is deterministic, so a take's length is predictable from the script.
 * This replaces the old planner-guessed range, whose max had to be clamped up
 * to 120s because raw recordings carried the recorder agent's think-time.
 */
function checkComputedDuration(actualSec, expectedSec, tolerance) {
  const t = typeof tolerance === "number" ? tolerance : 0.5
  const lo = expectedSec * (1 - t)
  const hi = expectedSec * (1 + t)
  const ok = actualSec >= lo && actualSec <= hi
  return {
    ok,
    detail: ok
      ? `duration ${actualSec.toFixed(2)}s matches expected ${expectedSec.toFixed(2)}s`
      : `duration ${actualSec.toFixed(2)}s outside [${lo.toFixed(2)}, ${hi.toFixed(2)}] ` +
        `expected from script (${expectedSec.toFixed(2)}s)`,
  }
}

module.exports = {
  parseBlackDetect,
  parseFreezeDetect,
  hasAudioStream,
  checkBlackFrames,
  checkComputedDuration,
  MAX_BLACK_FRACTION,
}
