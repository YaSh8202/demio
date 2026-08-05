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
  // pairs at ~18.7s, ~26.4s, ~32.7s — gaps between pairs are ~7.5s and ~6.1s
  assert.equal(groups.length, 3)
  assert.deepEqual(groups[0].actionIdxs, [0, 1])
  assert.equal(groups[0].startMs, 18730)
  assert.equal(groups[0].endMs, 18939) // 18914 + 25
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
  // action group 0 footage: src [17930, 20139] = 2209ms; voice need 2879+300=3179 → hold 970
  assert.equal(edl.slots[1].srcStartMs, 18730 - 800)
  assert.equal(edl.slots[1].srcEndMs, 18939 + 1200)
  assert.equal(edl.slots[1].holdMs, 3179 - 2209)
  // anchor 2 (action idx 2) lands in GROUP 1 (actions 2+3) = slots[2]:
  // footage [25623, 27792] = 2169ms; need 2508+300=2808 → hold 639
  assert.equal(edl.slots[2].holdMs, 2808 - 2169)
  // group 2 (actions 4+5) has no voice: footage only, no hold
  assert.equal(edl.slots[3].holdMs, 0)
  // segment outStartMs sits at its slot's outStartMs
  assert.equal(edl.segments[0].outStartMs, edl.slots[0].outStartMs)
  assert.equal(edl.segments[1].outStartMs, edl.slots[1].outStartMs)
  // total is far below the raw 40.7s
  assert.ok(edl.totalMs < 20000, `expected tight cut, got ${edl.totalMs}`)
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
  // need = 2000 + 300 + 1500 + 300 = 4100 > footage 2209 → hold 1891
  assert.equal(slot.holdMs, 4100 - 2209)
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
  assert.equal(actions[1].srcEndMs, 10000) // 9900 + 1200 clamps
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
