const test = require("node:test")
const assert = require("node:assert")
const {
  parseBlackDetect,
  parseFreezeDetect,
  hasAudioStream,
  checkBlackFrames,
  checkComputedDuration,
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
