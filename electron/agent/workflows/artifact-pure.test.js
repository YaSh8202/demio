const test = require("node:test")
const assert = require("node:assert")
const {
  parseBlackDetect,
  parseFreezeDetect,
  hasAudioStream,
  checkBlackFrames,
  checkComputedDuration,
  UPPER_HEADROOM_SEC,
} = require("./artifact-pure.cjs")

test("parseBlackDetect: extracts every span", () => {
  const stderr = [
    "[blackdetect @ 0x7f8] black_start:0 black_end:1.5 black_duration:1.5",
    "some unrelated ffmpeg noise",
    "[blackdetect @ 0x7f8] black_start:10.25 black_end:12 black_duration:1.75",
  ].join("\n")
  const spans = parseBlackDetect(stderr)
  assert.equal(spans.length, 2)
  assert.equal(spans[0].durationSec, 1.5)
  assert.equal(spans[1].startSec, 10.25)
})

test("parseBlackDetect: no matches returns empty", () => {
  assert.deepEqual(parseBlackDetect("nothing here"), [])
})

test("parseFreezeDetect: pairs start with duration", () => {
  const stderr = [
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 5.1",
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 3.2",
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 8.3",
  ].join("\n")
  const spans = parseFreezeDetect(stderr)
  assert.equal(spans.length, 1)
  assert.equal(spans[0].startSec, 5.1)
  assert.equal(spans[0].durationSec, 3.2)
})

test("parseFreezeDetect: no filter output returns empty", () => {
  assert.deepEqual(parseFreezeDetect("nothing here"), [])
})

test("parseFreezeDetect: dangling freeze_start emitted as open", () => {
  const stderr = "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 25.0"
  const spans = parseFreezeDetect(stderr)
  assert.equal(spans.length, 1)
  assert.equal(spans[0].startSec, 25.0)
  assert.equal(spans[0].durationSec, 0)
  assert.equal(spans[0].open, true)
})

test("parseFreezeDetect: multiple spans with one dangling", () => {
  const stderr = [
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 5.1",
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 3.2",
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 15.0",
  ].join("\n")
  const spans = parseFreezeDetect(stderr)
  assert.equal(spans.length, 2)
  assert.equal(spans[0].startSec, 5.1)
  assert.equal(spans[0].durationSec, 3.2)
  assert.equal(spans[0].open, undefined)
  assert.equal(spans[1].startSec, 15.0)
  assert.equal(spans[1].durationSec, 0)
  assert.equal(spans[1].open, true)
})

test("hasAudioStream: detects an Audio stream line in ffmpeg -i output", () => {
  const withAudio = [
    "  Stream #0:0(und): Video: h264 (avc1 / 0x31637661), yuv420p, 1280x800, 30 fps",
    "  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo",
  ].join("\n")
  assert.equal(hasAudioStream(withAudio), true)
})

test("hasAudioStream: a video-only input has no audio", () => {
  assert.equal(
    hasAudioStream("  Stream #0:0(und): Video: vp9, yuv420p, 1280x800, 30 fps"),
    false
  )
  assert.equal(hasAudioStream(""), false)
})

test("checkBlackFrames: a short black span passes", () => {
  const r = checkBlackFrames([{ startSec: 0, endSec: 0.6, durationSec: 0.6 }], 30)
  assert.equal(r.ok, true)
})

test("checkBlackFrames: black over half the recording fails", () => {
  const r = checkBlackFrames([{ startSec: 0, endSec: 20, durationSec: 20 }], 30)
  assert.equal(r.ok, false)
  assert.match(r.detail, /20/)
})

test("checkBlackFrames: no black spans passes with a clean detail", () => {
  const r = checkBlackFrames([], 30)
  assert.equal(r.ok, true)
  assert.match(r.detail, /no black/)
})

test("checkBlackFrames: exactly at half threshold passes", () => {
  const r = checkBlackFrames([{ startSec: 0, endSec: 15, durationSec: 15 }], 30)
  assert.equal(r.ok, true)
})

test("checkBlackFrames: zero duration passes (emptiness is video-exists job)", () => {
  const r = checkBlackFrames([{ startSec: 0, endSec: 5, durationSec: 5 }], 0)
  assert.equal(r.ok, true)
})

test("checkComputedDuration: within tolerance passes", () => {
  const r = checkComputedDuration(10.4, 10, 0.5)
  assert.equal(r.ok, true)
})

test("checkComputedDuration: far too short fails and reports both numbers", () => {
  const r = checkComputedDuration(4, 10, 0.5)
  assert.equal(r.ok, false)
  assert.match(r.detail, /4/)
  assert.match(r.detail, /10/)
})

test("checkComputedDuration: default tolerance is 0.5 (two args inside bound)", () => {
  const r = checkComputedDuration(14, 10)
  assert.equal(r.ok, true)
})

test("checkComputedDuration: default tolerance is 0.5 (two args outside bound)", () => {
  // 10 * 1.5 + 5 = 20 is the upper bound, so the "outside" case must clear it.
  const r = checkComputedDuration(21, 10)
  assert.equal(r.ok, false)
})

test("checkComputedDuration: exactly on the upper bound passes", () => {
  const r = checkComputedDuration(20, 10)
  assert.equal(r.ok, true)
})

test("checkComputedDuration: far too long fails and reports both numbers", () => {
  const r = checkComputedDuration(25, 10, 0.5)
  assert.equal(r.ok, false)
  assert.match(r.detail, /25/)
  assert.match(r.detail, /10/)
})

// The upper bound must absorb the per-command overhead `expectedDurationMs`
// does not model (navigation, network, one subprocess spawn per command).
// Numbers here are the shipped fixture's scene-02: one action, settleMs 2000,
// ACTION_BASELINE_MS 400 → expected 2.4s, against a real take of 3-4.5s.
test("checkComputedDuration: a short script's real take fits inside the headroom", () => {
  for (const actual of [3.0, 4.0, 4.5]) {
    const r = checkComputedDuration(actual, 2.4)
    assert.equal(r.ok, true, `${actual}s should pass against 2.4s expected`)
  }
  // The headroom is what carries those: the relative-only band was
  // [1.2, 3.6], so 4.0s and 4.5s would both have failed a good take. Tied to
  // the exported constant so shrinking it re-breaks this test loudly.
  assert.ok(2.4 * 1.5 < 4.0, "relative-only upper bound must be below 4.0s")
  assert.ok(
    2.4 * 1.5 + UPPER_HEADROOM_SEC >= 4.5,
    "UPPER_HEADROOM_SEC must still cover a 4.5s take against 2.4s expected"
  )
})

test("checkComputedDuration: a genuine hang still fails", () => {
  const r = checkComputedDuration(60, 10)
  assert.equal(r.ok, false)
  assert.match(r.detail, /60/)
})

test("checkComputedDuration: headroom does not loosen the lower bound", () => {
  // Truncation is proportional, so the lower bound is untouched: 1.1s against
  // a 2.4s expectation is still short of 2.4 * 0.5 = 1.2s.
  const r = checkComputedDuration(1.1, 2.4)
  assert.equal(r.ok, false)
})
