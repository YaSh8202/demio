const test = require("node:test")
const assert = require("node:assert")
const {
  EDL_DEFAULTS,
  parseActionEntries,
  groupActions,
  buildEdl,
  validateEdl,
} = require("./edl-pure.cjs")

// Real scene-01 action timeline (from a live run)
const SCENE_01_JSONL = [
  { action: "type", args: { text: "Buy groceries" }, durationMs: 1732, ok: true, tsMs: 18730 },
  { action: "press", args: { key: "Enter" }, durationMs: 25, ok: true, tsMs: 18914 },
  { action: "type", args: { text: "Schedule dentist appointment" }, durationMs: 2938, ok: true, tsMs: 26423 },
  { action: "press", args: { key: "Enter" }, durationMs: 2, ok: true, tsMs: 26590 },
  { action: "type", args: { text: "Read a chapter of a book" }, durationMs: 2609, ok: true, tsMs: 32688 },
  { action: "press", args: { key: "Enter" }, durationMs: 2, ok: true, tsMs: 32850 },
].map((l) => JSON.stringify(l)).join("\n")

test("parseActionEntries: parses ok lines in tsMs order with stable idx", () => {
  const entries = parseActionEntries(SCENE_01_JSONL)
  assert.equal(entries.length, 6)
  assert.equal(entries[0].idx, 0)
  assert.equal(entries[0].tsMs, 18730)
  assert.equal(entries[5].action, "press")
})

test("parseActionEntries: skips ok:false and unparseable lines", () => {
  const jsonl = [
    JSON.stringify({ action: "click", ok: false, tsMs: 100, durationMs: 5 }),
    "not-json",
    JSON.stringify({ action: "click", ok: true, tsMs: 200, durationMs: 5 }),
  ].join("\n")
  const entries = parseActionEntries(jsonl)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].idx, 0)
  assert.equal(entries[0].tsMs, 200)
})

test("groupActions: merges type→Enter pairs, splits across think-time gaps", () => {
  const entries = parseActionEntries(SCENE_01_JSONL)
  const groups = groupActions(entries, EDL_DEFAULTS.mergeGapMs)
  // tsMs = action END. Pair windows: [16998, 18914], [23485, 26590],
  // [30079, 32850] — inter-group gaps 4571ms and 3489ms, both > mergeGap 3000
  assert.equal(groups.length, 3)
  assert.deepEqual(groups[0].actionIdxs, [0, 1])
  assert.equal(groups[0].startMs, 16998) // 18730 - 1732
  assert.equal(groups[0].endMs, 18914) // Enter's tsMs
  assert.deepEqual(groups[2].actionIdxs, [4, 5])
})

test("buildEdl: voiced scene — slots contiguous, voice drives holds", () => {
  const entries = parseActionEntries(SCENE_01_JSONL)
  const edl = buildEdl({
    actionEntries: entries,
    videoDurationMs: 40700,
    segments: [
      { anchor: "intro", durationMs: 3715 },
      { anchor: 0, durationMs: 2879 },
      { anchor: 2, durationMs: 2508 },
      { anchor: "outro", durationMs: 2601 },
    ],
  })
  // intro + 3 action groups + outro
  assert.equal(edl.slots.length, 5)
  assert.equal(edl.slots[0].kind, "intro")
  assert.equal(edl.slots[4].kind, "outro")
  const v = validateEdl(edl, 40700)
  assert.deepEqual(v, { ok: true, errors: [] })
  // intro slot: voice need = 3715 + 300 gap = 4015 > minHold 2000
  assert.equal(edl.slots[0].outEndMs - edl.slots[0].outStartMs, 4015)
  // action group 0 footage: src [16198, 20114] = 3916ms (window [16998,
  // 18914] ± pads); voice need 2879+300=3179 < footage → no hold
  assert.equal(edl.slots[1].srcStartMs, 16998 - 800)
  assert.equal(edl.slots[1].srcEndMs, 18914 + 1200)
  assert.equal(edl.slots[1].holdMs, 0)
  // anchor 2 (action idx 2) lands in GROUP 1 (actions 2+3) = slots[2]:
  // footage [22685, 27790] = 5105ms; need 2508+300=2808 < footage → no hold
  assert.equal(edl.slots[2].holdMs, 0)
  // group 2 (actions 4+5) has no voice: footage only, no hold
  assert.equal(edl.slots[3].holdMs, 0)
  // segment outStartMs sits at its slot's outStartMs
  assert.equal(edl.segments[0].outStartMs, edl.slots[0].outStartMs)
  assert.equal(edl.segments[1].outStartMs, edl.slots[1].outStartMs)
  // total: 4015 + 3916 + 5105 + 4771 + 2901 = 20708 — half the raw 40.7s
  assert.equal(edl.totalMs, 20708)
})

test("buildEdl: voiceless — slots are action windows + pads, minHold intro/outro", () => {
  const entries = parseActionEntries(SCENE_01_JSONL)
  const edl = buildEdl({ actionEntries: entries, videoDurationMs: 40700, segments: [] })
  assert.equal(edl.slots.length, 5)
  for (const s of edl.slots) {
    if (s.kind === "action") assert.equal(s.holdMs, 0)
    else assert.equal(s.outEndMs - s.outStartMs, EDL_DEFAULTS.minHoldMs)
  }
  assert.deepEqual(validateEdl(edl, 40700), { ok: true, errors: [] })
})

test("buildEdl: multiple segments on one anchor stack with gaps", () => {
  const entries = parseActionEntries(SCENE_01_JSONL)
  const edl = buildEdl({
    actionEntries: entries,
    videoDurationMs: 40700,
    segments: [
      { anchor: 0, durationMs: 2000 },
      { anchor: 0, durationMs: 1500 },
    ],
  })
  const seg0 = edl.segments[0]
  const seg1 = edl.segments[1]
  assert.equal(seg1.outStartMs, seg0.outStartMs + 2000 + EDL_DEFAULTS.segmentGapMs)
  const slot = edl.slots.find((s) => s.segmentIdxs.length === 2)
  // need = 2000 + 300 + 1500 + 300 = 4100 > footage 3916 → hold 184
  assert.equal(slot.holdMs, 4100 - 3916)
})

test("buildEdl: out-of-range action anchor clamps to last group", () => {
  const entries = parseActionEntries(SCENE_01_JSONL)
  const edl = buildEdl({
    actionEntries: entries,
    videoDurationMs: 40700,
    segments: [{ anchor: 99, durationMs: 1000 }],
  })
  const lastAction = edl.slots.filter((s) => s.kind === "action").at(-1)
  assert.deepEqual(lastAction.segmentIdxs, [0])
  assert.deepEqual(validateEdl(edl, 40700), { ok: true, errors: [] })
})

test("buildEdl: no actions at all — single action slot spans whole video", () => {
  const edl = buildEdl({ actionEntries: [], videoDurationMs: 12000, segments: [] })
  const action = edl.slots.find((s) => s.kind === "action")
  assert.equal(action.srcStartMs, 0)
  assert.equal(action.srcEndMs, 12000)
  assert.deepEqual(validateEdl(edl, 12000), { ok: true, errors: [] })
})

test("buildEdl: pads clamp at video bounds", () => {
  // action right at the start and end of a short clip
  const jsonl = [
    JSON.stringify({ action: "click", ok: true, tsMs: 200, durationMs: 100 }),
    JSON.stringify({ action: "click", ok: true, tsMs: 9500, durationMs: 400 }),
  ].join("\n")
  const edl = buildEdl({
    actionEntries: parseActionEntries(jsonl),
    videoDurationMs: 10000,
    segments: [],
  })
  const actions = edl.slots.filter((s) => s.kind === "action")
  assert.equal(actions[0].srcStartMs, 0) // 200 - 800 clamps
  assert.equal(actions[1].srcEndMs, 10000) // 9500 + 1200 clamps
  assert.deepEqual(validateEdl(edl, 10000), { ok: true, errors: [] })
})

test("validateEdl: catches src range beyond video and non-contiguous slots", () => {
  const entries = parseActionEntries(SCENE_01_JSONL)
  const edl = buildEdl({ actionEntries: entries, videoDurationMs: 40700, segments: [] })
  const broken = JSON.parse(JSON.stringify(edl))
  broken.slots[1].srcEndMs = 99999
  assert.equal(validateEdl(broken, 40700).ok, false)
  const gapped = JSON.parse(JSON.stringify(edl))
  gapped.slots[1].outStartMs += 50
  assert.equal(validateEdl(gapped, 40700).ok, false)
})

const {
  buildSlotArgs,
  buildConcatListText,
  buildMixArgs,
  buildSilentAudioArgs,
} = require("./edl-pure.cjs")

test("buildSlotArgs: input-side trim (-ss/-t BEFORE -i) so tpad sees EOF", () => {
  const hold = buildSlotArgs(
    "scenes/scene-01.webm",
    { srcStartMs: 17930, srcEndMs: 20139, holdMs: 970 },
    "scenes/scene-01.slots/slot-01.mp4"
  )
  // -ss/-t must be INPUT options (before -i): the demuxer then EOFs at the
  // trim end, which is what makes tpad append its cloned frames. As output
  // options, -to would stop the muxer at srcEnd while tpad's padding only
  // arrives after the FULL source drains — holds would never render.
  const iPos = hold.indexOf("-i")
  assert.ok(hold.indexOf("-ss") < iPos)
  assert.ok(hold.indexOf("-t") < iPos)
  assert.deepEqual(hold.slice(hold.indexOf("-ss"), hold.indexOf("-ss") + 4), ["-ss", "17.930", "-t", "2.209"])
  assert.ok(hold.join(" ").includes("tpad=stop_mode=clone:stop_duration=0.970"))
  assert.ok(hold.includes("-an"))
  assert.ok(hold.join(" ").includes("libx264"))
  const noHold = buildSlotArgs("s.webm", { srcStartMs: 0, srcEndMs: 1000, holdMs: 0 }, "o.mp4")
  assert.ok(!noHold.join(" ").includes("tpad"))
})

test("buildConcatListText: escapes single quotes", () => {
  const txt = buildConcatListText(["/a/plain.mp4", "/b/it's.mp4"])
  assert.equal(txt, "file '/a/plain.mp4'\nfile '/b/it'\\''s.mp4'")
})

test("buildMixArgs: adelay per segment at outStartMs, video stream copied", () => {
  const args = buildMixArgs(
    "scenes/scene-01.retimed.mp4",
    [
      { file: "scenes/scene-01.voice-01.mp3", outStartMs: 0 },
      { file: "scenes/scene-01.voice-02.mp3", outStartMs: 4015 },
    ],
    "scenes/scene-01.final.mp4"
  )
  const fc = args[args.indexOf("-filter_complex") + 1]
  assert.ok(fc.includes("[1:a]adelay=0|0[a0]"))
  assert.ok(fc.includes("[2:a]adelay=4015|4015[a1]"))
  assert.ok(fc.includes("amix=inputs=2:dropout_transition=0:normalize=0"))
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "copy"])
  assert.ok(args.join(" ").includes("-ar 44100"))
  assert.ok(args.join(" ").includes("-ac 2"))
})

test("buildSilentAudioArgs: anullsrc silent track, video copied", () => {
  const args = buildSilentAudioArgs("in.mp4", "out.mp4")
  assert.ok(args.join(" ").includes("anullsrc=channel_layout=stereo:sample_rate=44100"))
  assert.ok(args.includes("-shortest"))
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "copy"])
})
