// Pure EDL (edit-decision-list) construction for the sync/retiming engine.
// CommonJS so node --test runs it directly with zero build step (same
// pattern as verify-pure.cjs). No I/O, no Date, no randomness — every
// function is a deterministic data transform, unit-tested in
// edl-pure.test.js.
"use strict"

const EDL_DEFAULTS = {
  preRollMs: 800, // footage kept before an action group starts
  postRollMs: 1200, // footage kept after it ends (viewer sees the result)
  segmentGapMs: 300, // breathing room after every voice segment
  minHoldMs: 2000, // minimum intro/outro freeze length
  mergeGapMs: 3000, // actions closer than this share one slot
  freezeSourceMs: 100, // real footage a freeze slot trims before tpad-cloning
  introBackoffMs: 500, // intro frame is taken this far before action 0
}

function parseActionEntries(jsonl) {
  const entries = []
  for (const line of String(jsonl).split("\n")) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.ok !== true || typeof e.tsMs !== "number") continue
    entries.push({
      tsMs: e.tsMs,
      durationMs: typeof e.durationMs === "number" ? e.durationMs : 0,
      action: typeof e.action === "string" ? e.action : "<unknown>",
      argsSummary: summarizeArgs(e.action, e.args),
    })
  }
  entries.sort((a, b) => a.tsMs - b.tsMs)
  return entries.map((e, idx) => ({ idx, ...e }))
}

function summarizeArgs(action, args) {
  if (!args || typeof args !== "object") return ""
  if (typeof args.text === "string") return JSON.stringify(args.text)
  if (typeof args.key === "string") return args.key
  if (typeof args.selector === "string") return args.selector
  return ""
}

function groupActions(entries, mergeGapMs) {
  const groups = []
  for (const e of entries) {
    const endMs = e.tsMs + e.durationMs
    const last = groups[groups.length - 1]
    if (last && e.tsMs - last.endMs < mergeGapMs) {
      last.endMs = endMs
      last.actionIdxs.push(e.idx)
    } else {
      groups.push({ startMs: e.tsMs, endMs, actionIdxs: [e.idx] })
    }
  }
  return groups
}

/** Voice time a list of segments needs inside one slot: each segment's
 * duration plus a trailing breathing gap. */
function voiceNeedMs(segs, gapMs) {
  return segs.reduce((sum, s) => sum + s.durationMs + gapMs, 0)
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * Build the EDL. `segments` arrive in the narrator's playback order; each is
 * `{ anchor: "intro" | "outro" | actionIdx, durationMs }`. Action-index
 * anchors resolve to the GROUP containing that action; out-of-range indexes
 * clamp to the last group (or intro when there are no groups at all).
 */
function buildEdl({ actionEntries, videoDurationMs, segments, opts }) {
  const o = { ...EDL_DEFAULTS, ...(opts || {}) }
  let groups = groupActions(actionEntries, o.mergeGapMs)
  // Degenerate capture with no ok actions: keep the whole video as one slot
  // so the pipeline still produces output (recording verification normally
  // prevents this — actions-ok is a hard check).
  if (groups.length === 0) {
    groups = [{ startMs: 0, endMs: videoDurationMs, actionIdxs: [] }]
  }

  // Assign each segment (by input index) to a slot key.
  const idxToGroup = new Map()
  groups.forEach((g, gi) => g.actionIdxs.forEach((ai) => idxToGroup.set(ai, gi)))
  const bySlot = { intro: [], outro: [], groups: groups.map(() => []) }
  segments.forEach((seg, si) => {
    const s = { ...seg, srcIdx: si }
    if (seg.anchor === "intro") bySlot.intro.push(s)
    else if (seg.anchor === "outro") bySlot.outro.push(s)
    else {
      const gi = idxToGroup.has(seg.anchor) ? idxToGroup.get(seg.anchor) : groups.length - 1
      bySlot.groups[gi].push(s)
    }
  })

  const slots = []
  const outSegments = []
  let cursor = 0

  const pushSlot = (kind, srcStartMs, srcEndMs, slotSegs, minDurMs) => {
    const footageMs = srcEndMs - srcStartMs
    const needMs = voiceNeedMs(slotSegs, o.segmentGapMs)
    const durMs = Math.max(footageMs, needMs, minDurMs)
    const slot = {
      kind,
      srcStartMs,
      srcEndMs,
      holdMs: durMs - footageMs,
      outStartMs: cursor,
      outEndMs: cursor + durMs,
      actionIdxs: [],
      segmentIdxs: [],
    }
    let voiceCursor = cursor
    for (const s of slotSegs) {
      slot.segmentIdxs.push(s.srcIdx)
      outSegments.push({
        idx: s.srcIdx,
        anchor: s.anchor,
        durationMs: s.durationMs,
        outStartMs: voiceCursor,
      })
      voiceCursor += s.durationMs + o.segmentGapMs
    }
    cursor = slot.outEndMs
    slots.push(slot)
    return slot
  }

  // Intro: freeze the frame just before the first action lands.
  const introSrc = clamp(
    groups[0].startMs - o.introBackoffMs,
    0,
    Math.max(0, videoDurationMs - o.freezeSourceMs)
  )
  pushSlot("intro", introSrc, introSrc + o.freezeSourceMs, bySlot.intro, o.minHoldMs)

  // Action groups: footage window ± padding, clamped to video bounds and to
  // the previous slot's src end so kept footage never overlaps.
  let prevSrcEnd = 0
  groups.forEach((g, gi) => {
    const srcStart = clamp(g.startMs - o.preRollMs, prevSrcEnd === 0 ? 0 : prevSrcEnd, videoDurationMs)
    const srcEnd = clamp(g.endMs + o.postRollMs, srcStart + 1, videoDurationMs)
    const slot = pushSlot("action", srcStart, srcEnd, bySlot.groups[gi], 0)
    slot.actionIdxs = [...g.actionIdxs]
    prevSrcEnd = srcEnd
  })

  // Outro: freeze the final kept frame.
  const outroSrc = clamp(prevSrcEnd - o.freezeSourceMs, 0, Math.max(0, videoDurationMs - o.freezeSourceMs))
  pushSlot("outro", outroSrc, outroSrc + o.freezeSourceMs, bySlot.outro, o.minHoldMs)

  return {
    version: 1,
    videoDurationMs,
    opts: o,
    slots,
    segments: outSegments,
    totalMs: cursor,
  }
}

function validateEdl(edl, videoDurationMs) {
  const errors = []
  if (!edl || !Array.isArray(edl.slots) || edl.slots.length === 0) {
    return { ok: false, errors: ["edl has no slots"] }
  }
  let prevOutEnd = 0
  const seenSegIdxs = new Set()
  edl.slots.forEach((s, i) => {
    if (s.srcStartMs < 0 || s.srcEndMs > videoDurationMs || s.srcStartMs >= s.srcEndMs) {
      errors.push(`slot ${i}: src range [${s.srcStartMs}, ${s.srcEndMs}] invalid for video ${videoDurationMs}ms`)
    }
    if (s.holdMs < 0) errors.push(`slot ${i}: negative holdMs ${s.holdMs}`)
    if (s.outStartMs !== prevOutEnd) {
      errors.push(`slot ${i}: outStartMs ${s.outStartMs} != previous outEndMs ${prevOutEnd}`)
    }
    const expectedDur = s.srcEndMs - s.srcStartMs + s.holdMs
    if (s.outEndMs - s.outStartMs !== expectedDur) {
      errors.push(`slot ${i}: out duration ${s.outEndMs - s.outStartMs} != footage+hold ${expectedDur}`)
    }
    for (const si of s.segmentIdxs) {
      if (seenSegIdxs.has(si)) errors.push(`segment ${si} referenced by more than one slot`)
      seenSegIdxs.add(si)
    }
    prevOutEnd = s.outEndMs
  })
  if (edl.totalMs !== prevOutEnd) {
    errors.push(`totalMs ${edl.totalMs} != last slot outEndMs ${prevOutEnd}`)
  }
  const segs = [...(edl.segments || [])].sort((a, b) => a.outStartMs - b.outStartMs)
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const slot = edl.slots.find((s) => s.segmentIdxs.includes(seg.idx))
    if (!slot) {
      errors.push(`segment ${seg.idx} not referenced by any slot`)
      continue
    }
    if (seg.outStartMs < slot.outStartMs || seg.outStartMs + seg.durationMs > slot.outEndMs) {
      errors.push(`segment ${seg.idx} [${seg.outStartMs}, ${seg.outStartMs + seg.durationMs}] escapes slot [${slot.outStartMs}, ${slot.outEndMs}]`)
    }
    if (i > 0) {
      const prev = segs[i - 1]
      if (prev.outStartMs + prev.durationMs > seg.outStartMs) {
        errors.push(`segments ${prev.idx} and ${seg.idx} overlap`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

module.exports = {
  EDL_DEFAULTS,
  parseActionEntries,
  groupActions,
  buildEdl,
  validateEdl,
}
