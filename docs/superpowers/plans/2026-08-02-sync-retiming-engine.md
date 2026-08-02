# Sync/Retiming Engine (Milestone 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut recorder think-time out of raw scene captures and align narration to on-screen actions via a deterministic, narration-driven edit-decision-list (EDL), turning a 70s mostly-idle capture into a tight, synced demo.

**Architecture:** After recording + narration + TTS (real MP3 durations known), a pure EDL builder converts each scene's `actions.jsonl` + segment durations into timed slots (`max(action window + padding, voice duration + gap)`), with freeze-frame holds (`tpad stop_mode=clone`) for intro/outro and voice overrun. A staged ffmpeg renderer (trim slots → concat → mix voice or silent track) produces one uniform `scene-XX.final.mp4` per scene; the existing compose step becomes a pure `-c copy` concat. The narrator stops doing timeline math entirely — it anchors segments to `"intro" | actionIndex | "outro"`.

**Tech Stack:** TypeScript (Electron main), Mastra workflows (`@mastra/core@1.55`), ffmpeg (trim/tpad/concat/adelay/amix), ElevenLabs TTS, node:test for pure-CJS units (same pattern as `verify-pure.cjs`).

## Global Constraints

- Package manager is **bun**, never npm/npx.
- Style: no semicolons, double quotes, 2-space indent, `import type` for type-only imports (Prettier + strict TS enforced).
- Pure logic ships as CommonJS `.cjs` runnable by `node --test` with zero build step, `require`d from TS via `createRequire` (established pattern: `verify-pure.cjs` / `verify.ts` / `vite.main.config.ts` copy plugin).
- Decrypted API keys must NEVER enter workflow `inputData`/state (they get snapshotted to LibSQLStore) — re-read via `getDecryptedKey("elevenlabs")` at execution time.
- All ffmpeg invocations via `execFile` argv arrays (no shell strings); resolve binary via `resolveFfmpeg()` from `electron/lib/ffmpeg`.
- Audio pinned to `-ar 44100 -ac 2` aac, video to `libx264 -pix_fmt yuv420p -r 30` everywhere a stream is (re)encoded — final concat is `-c copy` and requires uniformity.
- Sync failures are deterministic code bugs: validate EDL pre-render (pure function), hard-fail post-render with artifacts left on disk. NO workflow suspend, NO retry, NO silent degrade to unretimed video.
- This plan executes on a NEW branch created AFTER `worktree-agent-harness` (M1) merges to main (user decision). The plan doc itself is committed on the M1 branch.

## Background facts (verified from a real run)

Workspace `~/.demio/workspaces/b12e11d4-.../`:

- `scene-01.webm`: 40.7s, vp8, 1280x800, **10 fps**. Actions span 18.73s–32.85s. 18.7s idle head, ~8s idle tail.
- `scene-02.webm`: 28.9s. ONE action at 19.88s (0.97s long). 3 voice segments.
- `actions.jsonl` line shape: `{"action":"type","args":{...},"durationMs":1732,"frameIdx":187,"ok":true,"target":{"x":662,"y":207},"tsMs":18730}` — `frameIdx = tsMs/100` at 10fps. `target` x/y exists for click/type (future zoom work, out of scope here).
- Actions come in tight pairs: `type` then `press Enter` ~170ms later — MUST merge into one slot (`mergeGapMs`).
- Voice MP3s run 2.5–3.7s each (`mp3_44100_128` = 128kbps CBR).

## Non-goals (explicitly deferred)

- Zoom/emphasis at click coordinates, captions/subtitles, vision-judge verification, per-scene pacing UI. 
- Renderer UI changes: `workflow-progress.tsx` already collapses post-recording work into one "Finalizing — narrating, voicing, and composing…" row; sync runs inside that window. No UI task.
- Keep-idle-footage-before-freezing refinement (freeze-only holds for now).

## File structure

| File | Status | Responsibility |
|---|---|---|
| `electron/agent/lib/media-probe.ts` | Create | Shared `probeDurationSec()` (ffmpeg stderr parse), extracted from `verify.ts` |
| `electron/agent/workflows/edl-pure.cjs` | Create | Pure: `EDL_DEFAULTS`, `parseActionEntries`, `groupActions`, `buildEdl`, `validateEdl`, ffmpeg arg builders |
| `electron/agent/workflows/edl-pure.test.js` | Create | node:test units for everything in `edl-pure.cjs` |
| `electron/agent/workflows/sync.ts` | Create | TS bridge (`createRequire`) + `renderScene()` staged ffmpeg execution + `edl.json` persistence + post-render check |
| `electron/agent/workflows/demo-video.ts` | Modify | Narrator anchor contract, tts→synthesis-only, new `syncStep`, compose→pure concat |
| `electron/agent/workflows/verify.ts` | Modify | Use shared `probeDurationSec` |
| `electron/agent/lib/voiceover.ts` | Modify | Synthesis-only API (`synthesizeNarrationAudio`); mixing/clamp/overlap logic deleted |
| `electron/agent/tools/voiceover.ts` | Delete | Dead agent tool (never registered — `voiceConfigured` always false) |
| `electron/agent/demio-agent.ts` | Modify | Remove dead voiceover tool wiring + dead voice opts |
| `vite.main.config.ts` | Modify | Copy plugin also ships `edl-pure.cjs` |
| `package.json` | Modify | `"test:workflows": "node --test electron/agent/workflows/*.test.js"` |
| `docs/superpowers/plans/manual-e2e-checklist.md` | Modify | M2 verification items |

## EDL data model (locked)

`scenes/<sceneId>.edl.json` (also the in-memory shape from `buildEdl`, plus `source`/segment `file`/`text` added by `sync.ts`):

```jsonc
{
  "version": 1,
  "source": "scenes/scene-01.webm",
  "videoDurationMs": 40700,
  "opts": { "preRollMs": 800, "postRollMs": 1200, "segmentGapMs": 300, "minHoldMs": 2000, "mergeGapMs": 3000, "freezeSourceMs": 100, "introBackoffMs": 500 },
  "slots": [
    { "kind": "intro",  "srcStartMs": 18230, "srcEndMs": 18330, "holdMs": 3915, "outStartMs": 0,    "outEndMs": 4015,  "actionIdxs": [],      "segmentIdxs": [0] },
    { "kind": "action", "srcStartMs": 17930, "srcEndMs": 20139, "holdMs": 970,  "outStartMs": 4015, "outEndMs": 7194,  "actionIdxs": [0, 1],  "segmentIdxs": [1] },
    // …one slot per action group, then an outro freeze — 5 slots total for
    // scene-01 (intro + 3 groups + outro); see Task 2's fixture test for the
    // fully worked arithmetic…
    { "kind": "outro",  "srcStartMs": 33952, "srcEndMs": 34052, "holdMs": 2801, "outStartMs": 12166, "outEndMs": 15067, "actionIdxs": [],     "segmentIdxs": [3] }
  ],
  "segments": [
    { "idx": 0, "anchor": "intro", "text": "Meet TodoMVC…", "file": "scenes/scene-01.voice-01.mp3", "durationMs": 3715, "outStartMs": 0 }
  ],
  "totalMs": 15067
}
```

Invariants (enforced by `validateEdl`): slots contiguous and monotonic (`slot[i].outStartMs === slot[i-1].outEndMs`, first at 0), `0 ≤ srcStartMs < srcEndMs ≤ videoDurationMs`, `holdMs ≥ 0`, `outEndMs - outStartMs === (srcEndMs - srcStartMs) + holdMs`, every segment lies fully inside its slot's out-range, segments non-overlapping in `outStartMs` order, `totalMs === last slot outEndMs`, each segment idx referenced by exactly one slot.

---

### Task 1: Shared media-probe helper

**Files:**
- Create: `electron/agent/lib/media-probe.ts`
- Modify: `electron/agent/workflows/verify.ts` (remove local `probeDurationSec`, lines 31–46, import shared one)

**Interfaces:**
- Consumes: `resolveFfmpeg()` from `electron/lib/ffmpeg` (returns `string | null`)
- Produces: `probeDurationSec(videoPath: string): Promise<number>` — throws `Error` when ffmpeg missing or duration unparseable. Used later by `sync.ts` (Task 3) and `verify.ts`.

- [ ] **Step 1: Create `electron/agent/lib/media-probe.ts`** — move the existing implementation verbatim from `verify.ts:31-46` (it is already correct):

```ts
// ── Media duration probe ─────────────────────────────────────────────────────
//
// `ffmpeg -i` prints "Duration: HH:MM:SS.cc" to stderr and exits non-zero
// without an output file — capture stderr regardless of exit code. Shared by
// the scene verifier and the sync renderer.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolveFfmpeg } from "../../lib/ffmpeg"

const execFileAsync = promisify(execFile)

export async function probeDurationSec(videoPath: string): Promise<number> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) throw new Error("no ffmpeg binary available to probe duration")
  let stderr = ""
  try {
    const r = await execFileAsync(ffmpeg, ["-i", videoPath], { encoding: "utf8" })
    stderr = r.stderr
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? ""
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) throw new Error(`could not read duration from ${videoPath}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}
```

- [ ] **Step 2: Refactor `verify.ts`** — delete its local `probeDurationSec` and the now-unused `execFile`/`promisify`/`resolveFfmpeg` imports; add `import { probeDurationSec } from "../lib/media-probe"`. No behavior change.

- [ ] **Step 3: Verify**

Run: `bun run typecheck && node --test electron/agent/workflows/verify.test.js`
Expected: typecheck clean; 6/6 tests pass (verify tests only exercise `verify-pure.cjs`, untouched).

- [ ] **Step 4: Commit**

```bash
git add electron/agent/lib/media-probe.ts electron/agent/workflows/verify.ts
git commit -m "refactor: extract shared probeDurationSec into lib/media-probe"
```

---

### Task 2: EDL core — pure builder + validator + tests

**Files:**
- Create: `electron/agent/workflows/edl-pure.cjs`
- Create: `electron/agent/workflows/edl-pure.test.js`
- Modify: `vite.main.config.ts` (copy plugin ships `edl-pure.cjs` alongside `verify-pure.cjs`)
- Modify: `package.json` (add `test:workflows` script)

**Interfaces:**
- Consumes: nothing (pure, no imports beyond nothing — plain CJS).
- Produces (all exported from `edl-pure.cjs`, consumed by `sync.ts` Task 3 and `demo-video.ts` Task 5/6):
  - `EDL_DEFAULTS: { preRollMs: 800, postRollMs: 1200, segmentGapMs: 300, minHoldMs: 2000, mergeGapMs: 3000, freezeSourceMs: 100, introBackoffMs: 500 }`
  - `parseActionEntries(jsonl: string) → Array<{ idx, tsMs, durationMs, action, argsSummary }>` — ok-lines only, sorted by `tsMs`, `idx` = position in that sorted ok-only list
  - `groupActions(entries, mergeGapMs) → Array<{ startMs, endMs, actionIdxs }>`
  - `buildEdl({ actionEntries, videoDurationMs, segments, opts? }) → edl` — `segments: Array<{ anchor: "intro"|"outro"|number, durationMs: number }>`; returns the EDL shape from "EDL data model" above minus `source`/segment `file`/`text`
  - `validateEdl(edl, videoDurationMs) → { ok: boolean, errors: string[] }`

- [ ] **Step 1: Write failing tests** in `edl-pure.test.js` (node:test + assert, same style as `verify.test.js`). Full test set:

```js
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
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test electron/agent/workflows/edl-pure.test.js`
Expected: FAIL — `Cannot find module './edl-pure.cjs'`

- [ ] **Step 3: Implement `edl-pure.cjs`**

```js
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
      last.endMs = Math.max(last.endMs, endMs)
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
```

- [ ] **Step 4: Run tests until green**

Run: `node --test electron/agent/workflows/edl-pure.test.js`
Expected: all pass. If an expected-value assertion fails, re-derive the arithmetic by hand from the fixture (the test values above were computed from the real scene-01 timeline) before touching either side.

- [ ] **Step 5: Ship `edl-pure.cjs` in the build** — in `vite.main.config.ts`, generalize the existing `copyVerifyPureCjs` plugin to copy both files (rename to `copyPureCjs`, iterate `["verify-pure.cjs", "edl-pure.cjs"]` with the same source/dest logic per file). Add to `package.json` scripts:

```json
"test:workflows": "node --test electron/agent/workflows/*.test.js"
```

- [ ] **Step 6: Verify build + full workflow tests**

Run: `bun run typecheck && bun run build && bun run test:workflows`
Expected: clean; both verify and edl test files pass.

- [ ] **Step 7: Commit**

```bash
git add electron/agent/workflows/edl-pure.cjs electron/agent/workflows/edl-pure.test.js vite.main.config.ts package.json
git commit -m "feat: pure EDL builder + validator for sync/retiming engine"
```

---

### Task 3: ffmpeg arg builders + staged scene renderer

**Files:**
- Modify: `electron/agent/workflows/edl-pure.cjs` (add pure arg builders) and `edl-pure.test.js` (their tests)
- Create: `electron/agent/workflows/sync.ts`

**Interfaces:**
- Consumes: `probeDurationSec` (Task 1), everything from `edl-pure.cjs` (Task 2), `resolveFfmpeg()` from `electron/lib/ffmpeg`.
- Produces (from `edl-pure.cjs`):
  - `buildSlotArgs(sourcePath, slot, outPath) → string[]` — trim + optional tpad hold + silent h264 encode
  - `buildConcatListText(paths: string[]) → string` — concat-demuxer list body (quote-escaped)
  - `buildMixArgs(retimedPath, segments, outputPath) → string[]` — `segments: Array<{ file, outStartMs }>`; adelay/amix voice onto retimed video, `-c:v copy`
  - `buildSilentAudioArgs(retimedPath, outputPath) → string[]` — anullsrc silent track, `-c:v copy`
- Produces (from `sync.ts`):
  - `parseActionEntries` re-export (typed) for Task 5's narrator prompt
  - `renderScene(opts: { workspace: string; sceneId: string; videoPath: string; actionsPath: string; segments: Array<{ text: string; anchor: "intro" | "outro" | number; file: string; durationMs: number }> }): Promise<{ finalPath: string; edlPath: string; totalMs: number }>` — `finalPath` absolute, always has an audio stream (voice mix or silence)

- [ ] **Step 1: Add failing arg-builder tests** to `edl-pure.test.js`:

```js
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
  assert.ok(fc.includes("amix=inputs=2:dropout_transition=0"))
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
```

Run: `node --test electron/agent/workflows/edl-pure.test.js` — expected FAIL (`buildSlotArgs is not a function`).

- [ ] **Step 2: Implement the builders** in `edl-pure.cjs` (append before `module.exports`, and export them):

```js
function msToSec(ms) {
  return (ms / 1000).toFixed(3)
}

/** Trim one slot from the raw capture, freeze-extend via tpad when the slot
 * holds, and encode to the uniform silent-video slot format.
 *
 * `-ss`/`-t` MUST be input options (before `-i`): the demuxer then reaches
 * EOF at the trim end, which is the signal tpad needs to append its cloned
 * frames. With output-side `-to`, the muxer would stop writing at srcEnd
 * while tpad's padding only arrives after the FULL source drains — the
 * freeze hold would silently never render. Input-side `-ss` on modern
 * ffmpeg seeks to the prior keyframe and decodes forward to the exact
 * requested time, so the cut stays frame-accurate. */
function buildSlotArgs(sourcePath, slot, outPath) {
  const args = [
    "-y",
    "-ss", msToSec(slot.srcStartMs),
    "-t", msToSec(slot.srcEndMs - slot.srcStartMs),
    "-i", sourcePath,
  ]
  if (slot.holdMs > 0) {
    args.push("-vf", `tpad=stop_mode=clone:stop_duration=${msToSec(slot.holdMs)}`)
  }
  args.push("-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", outPath)
  return args
}

function buildConcatListText(paths) {
  return paths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n")
}

/** Overlay voice segments onto the retimed (already h264) scene at their
 * EDL-computed offsets. Video is stream-copied — no second generation loss.
 * Audio pinned to 44100/stereo aac: the final compose concat is `-c copy`
 * and requires byte-identical stream parameters across scenes. */
function buildMixArgs(retimedPath, segments, outputPath) {
  const args = ["-y", "-i", retimedPath]
  for (const seg of segments) args.push("-i", seg.file)
  const parts = []
  const labels = []
  segments.forEach((seg, i) => {
    const d = Math.max(0, Math.round(seg.outStartMs))
    parts.push(`[${i + 1}:a]adelay=${d}|${d}[a${i}]`)
    labels.push(`[a${i}]`)
  })
  parts.push(`${labels.join("")}amix=inputs=${segments.length}:dropout_transition=0[aout]`)
  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "44100", "-ac", "2",
    outputPath
  )
  return args
}

/** Voiceless variant: attach a silent 44100/stereo track so every scene's
 * final file has an identical stream layout for the `-c copy` concat. */
function buildSilentAudioArgs(retimedPath, outputPath) {
  return [
    "-y",
    "-i", retimedPath,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-shortest",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "44100", "-ac", "2",
    outputPath,
  ]
}
```

Run the tests again — expected all green.

- [ ] **Step 3: Create `electron/agent/workflows/sync.ts`**:

```ts
// ── Sync/retiming renderer (Milestone 2) ─────────────────────────────────────
//
// Executes a scene's EDL as a staged ffmpeg pipeline — every intermediate
// lands on disk so a bad cut is diagnosable by inspecting files:
//
//   scenes/<id>.slots/slot-NN.mp4   (trim + freeze-hold, silent h264)
//   scenes/<id>.retimed.mp4         (slot concat, -c copy, video-only)
//   scenes/<id>.final.mp4           (voice mix OR silent track, uniform a/v)
//   scenes/<id>.edl.json            (persisted EDL — future re-render/edit)
//
// EDL math lives in edl-pure.cjs (unit-tested, no I/O). Failures here are
// deterministic code bugs, not agent flakiness — this module hard-throws and
// leaves artifacts in place; it never suspends or degrades to the raw video.

import { promises as fs } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { resolveFfmpeg } from "../../lib/ffmpeg"
import { probeDurationSec } from "../lib/media-probe"

const require = createRequire(import.meta.url)

export interface ActionEntry {
  idx: number
  tsMs: number
  durationMs: number
  action: string
  argsSummary: string
}

export type SegmentAnchor = "intro" | "outro" | number

export interface EdlSlot {
  kind: "intro" | "action" | "outro"
  srcStartMs: number
  srcEndMs: number
  holdMs: number
  outStartMs: number
  outEndMs: number
  actionIdxs: number[]
  segmentIdxs: number[]
}

export interface Edl {
  version: 1
  videoDurationMs: number
  opts: Record<string, number>
  slots: EdlSlot[]
  segments: Array<{ idx: number; anchor: SegmentAnchor; durationMs: number; outStartMs: number }>
  totalMs: number
}

const pure = require("./edl-pure.cjs") as {
  EDL_DEFAULTS: Record<string, number>
  parseActionEntries: (jsonl: string) => ActionEntry[]
  buildEdl: (input: {
    actionEntries: ActionEntry[]
    videoDurationMs: number
    segments: Array<{ anchor: SegmentAnchor; durationMs: number }>
    opts?: Record<string, number>
  }) => Edl
  validateEdl: (edl: Edl, videoDurationMs: number) => { ok: boolean; errors: string[] }
  buildSlotArgs: (sourcePath: string, slot: EdlSlot, outPath: string) => string[]
  buildConcatListText: (paths: string[]) => string
  buildMixArgs: (
    retimedPath: string,
    segments: Array<{ file: string; outStartMs: number }>,
    outputPath: string
  ) => string[]
  buildSilentAudioArgs: (retimedPath: string, outputPath: string) => string[]
}

export const parseActionEntries = pure.parseActionEntries

const execFileAsync = promisify(execFile)

export interface RenderSceneOpts {
  workspace: string
  sceneId: string
  /** Absolute path to the raw scene capture (.webm). */
  videoPath: string
  /** Absolute path to the scene's actions.jsonl. */
  actionsPath: string
  /** Playback-ordered synthesized segments; `file` is workspace-relative. */
  segments: Array<{ text: string; anchor: SegmentAnchor; file: string; durationMs: number }>
}

export async function renderScene(opts: RenderSceneOpts): Promise<{
  finalPath: string
  edlPath: string
  totalMs: number
}> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) throw new Error("ffmpeg binary not available — cannot retime scene")

  const jsonl = await fs.readFile(opts.actionsPath, "utf8")
  const actionEntries = pure.parseActionEntries(jsonl)
  const videoDurationMs = Math.round((await probeDurationSec(opts.videoPath)) * 1000)

  const edl = pure.buildEdl({
    actionEntries,
    videoDurationMs,
    segments: opts.segments.map((s) => ({ anchor: s.anchor, durationMs: s.durationMs })),
  })
  const validation = pure.validateEdl(edl, videoDurationMs)
  if (!validation.ok) {
    throw new Error(
      `sync: invalid EDL for ${opts.sceneId}: ${validation.errors.join("; ")}`
    )
  }

  // Persist the EDL (with text/file enrichment) BEFORE rendering so a
  // render failure still leaves the plan on disk for diagnosis.
  const edlPath = path.join(opts.workspace, "scenes", `${opts.sceneId}.edl.json`)
  await fs.writeFile(
    edlPath,
    JSON.stringify(
      {
        ...edl,
        source: path.relative(opts.workspace, opts.videoPath),
        segments: edl.segments.map((s) => ({
          ...s,
          text: opts.segments[s.idx]?.text,
          file: opts.segments[s.idx]?.file,
        })),
      },
      null,
      2
    )
  )

  // Stage 1: trim each slot (+freeze hold) to its own silent h264 clip.
  const slotsDir = path.join(opts.workspace, "scenes", `${opts.sceneId}.slots`)
  await fs.mkdir(slotsDir, { recursive: true })
  const slotPaths: string[] = []
  for (let i = 0; i < edl.slots.length; i++) {
    const slotPath = path.join(slotsDir, `slot-${String(i).padStart(2, "0")}.mp4`)
    await execFileAsync(ffmpeg, pure.buildSlotArgs(opts.videoPath, edl.slots[i], slotPath))
    slotPaths.push(slotPath)
  }

  // Stage 2: concat slots (identical encode params → stream copy).
  const listPath = path.join(slotsDir, "concat.txt")
  await fs.writeFile(listPath, pure.buildConcatListText(slotPaths))
  const retimedPath = path.join(opts.workspace, "scenes", `${opts.sceneId}.retimed.mp4`)
  await execFileAsync(ffmpeg, [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", retimedPath,
  ])

  // Stage 3: audio — voice mix at EDL offsets, or a silent track. Either
  // way the output has one video + one 44100/stereo aac stream so the
  // final demo concat can stream-copy.
  const finalPath = path.join(opts.workspace, "scenes", `${opts.sceneId}.final.mp4`)
  if (opts.segments.length > 0) {
    const mixSegments = edl.segments.map((s) => ({
      file: opts.segments[s.idx].file,
      outStartMs: s.outStartMs,
    }))
    await execFileAsync(ffmpeg, pure.buildMixArgs(retimedPath, mixSegments, finalPath), {
      cwd: opts.workspace,
    })
  } else {
    await execFileAsync(ffmpeg, pure.buildSilentAudioArgs(retimedPath, finalPath))
  }

  // Post-render check: rendered duration must match the EDL's arithmetic.
  // A drift beyond tolerance means a builder/renderer bug — fail loudly.
  const renderedMs = Math.round((await probeDurationSec(finalPath)) * 1000)
  if (Math.abs(renderedMs - edl.totalMs) > 1000) {
    throw new Error(
      `sync: rendered ${opts.sceneId} is ${renderedMs}ms but EDL computed ${edl.totalMs}ms ` +
        `(>1s drift) — inspect ${slotsDir} and ${edlPath}`
    )
  }

  return { finalPath, edlPath, totalMs: edl.totalMs }
}
```

Note for the implementer: `buildMixArgs` runs with `cwd: opts.workspace` because segment MP3 paths are workspace-relative (`scenes/<id>.voice-NN.mp3`) while `retimedPath`/`finalPath` are absolute — absolute paths are unaffected by `cwd`, so mixing the two is safe.

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run test:workflows && bun run build`
Expected: clean. (`renderScene` gets its live exercise in Task 6/7 — its ffmpeg staging is deliberately thin glue over the tested pure builders.)

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/edl-pure.cjs electron/agent/workflows/edl-pure.test.js electron/agent/workflows/sync.ts
git commit -m "feat: staged ffmpeg scene renderer driven by EDL"
```

---

### Task 4: Voiceover becomes synthesis-only; dead tool deleted

**Files:**
- Modify: `electron/agent/lib/voiceover.ts`
- Delete: `electron/agent/tools/voiceover.ts`
- Modify: `electron/agent/demio-agent.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `synthesizeNarrationAudio(opts: { cwd: string; sceneId: string; texts: string[]; voiceId: string; apiKey: string; signal?: AbortSignal }): Promise<Array<{ file: string; durationMs: number }>>` — `file` workspace-relative (`scenes/<sceneId>.voice-NN.mp3`), MP3s written to disk, durations probed. Throws `VoiceoverSynthesisError` (reasons: `"aborted" | "network" | "elevenlabs_error" | "probe_failed"`). Consumed by Task 6's `ttsStep`.
- Removes: `synthesizeSegments`, `VoiceSegment`, `SynthesizedVoiceover`, `SynthesizedSegmentDetail`, `buildFfmpegMixArgs`, the `"overlap"` failure reason, the scene-end clamp — timing is now entirely the EDL's job (`edl-pure.cjs`), and mixing is `sync.ts`'s.

- [ ] **Step 1: Rewrite `lib/voiceover.ts`.** Keep: header comment (updated), constants, `estimateMp3Duration128kbps`, `probeDurationSec` (MP3-specific with size fallback — intentionally NOT the shared video probe), `VoiceoverSynthesisError` (drop `"overlap"` from the reason union, drop the `segments` detail field — carry `synthesizedCount: number` instead for partial-progress reporting). Replace `synthesizeSegments` with:

```ts
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

    // fetch / error handling identical to the previous implementation
    // (network → "network", non-2xx → "elevenlabs_error" with status+body,
    // abort mid-fetch → "aborted"), writing tmp then renaming to abs.
    // …fetch block carried over verbatim, with `synthesized` replaced by
    // `out.length` in the error constructors…

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
```

The fetch block marked "carried over verbatim" means exactly `voiceover.ts:276-326` today (the `fetch`/`res.ok`/`arrayBuffer`/`writeFile`/`rename` sequence) — do not re-invent it; only the error-constructor third argument changes from the `synthesized` array to `out.length`.

- [ ] **Step 2: Delete the dead tool.** `git rm electron/agent/tools/voiceover.ts`. In `demio-agent.ts`: remove the `createVoiceoverTool` import, the whole `voiceConfigured` const and `synthesize_voiceover` spread in `customTools`, and the deprecated `voiceId` / `voiceName` / `elevenLabsKey` fields from `CreateDemioAgentOpts`; in the `systemPrompt(...)` fallback call pass `voiceConfigured: false, voiceName: null`. (The `synthesize_voiceover` registration was provably dead — both call sites always pass `instructionsOverride` and never pass voice opts; see the file's own `@deprecated` notes.)

- [ ] **Step 3: Confirm the split is respected.** IMPORTANT: this task keeps `synthesizeSegments` fully working — `synthesizeNarrationAudio` is ADDED alongside it, and only the tool + demio-agent wiring are deleted (their removal breaks nothing: the tool was never registered at runtime). `demo-video.ts`'s `ttsStep` keeps calling `synthesizeSegments` untouched until Task 6 rewires it and performs the actual deletion of `synthesizeSegments`/`buildFfmpegMixArgs`/the clamp. The "Removes" list in this task's Interfaces block describes the two-task NET effect; the deletions themselves land in Task 6 Step 5.

Run: `grep -rn "createVoiceoverTool\|synthesize_voiceover" electron/ src/ --include="*.ts" --include="*.tsx"`
Expected: no hits. `grep -rn "synthesizeSegments" electron/` still shows `lib/voiceover.ts` + `workflows/demo-video.ts` — expected until Task 6.

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run build && bun start` (boot only — confirm chat agent loads, no missing-module errors)
Expected: clean boot; `bun run test:workflows` still green.

- [ ] **Step 5: Commit**

```bash
git add -A electron/agent
git commit -m "feat: synthesis-only voiceover API; delete dead synthesize_voiceover tool"
```

---

### Task 5: Narrator anchor contract

**Files:**
- Modify: `electron/agent/workflows/demo-video.ts` (`narrationSegmentsSchema`, `NARRATOR_INSTRUCTIONS`, `narrateStep` prompt)

**Interfaces:**
- Consumes: `parseActionEntries` from `./sync` (Task 3).
- Produces: `narrationSegmentsSchema` now `{ scenes: [{ sceneId, segments: [{ text, anchor: "intro" | "outro" | number }] }] }` — consumed by Task 6's `ttsStep`/`syncStep`. `atSec` is gone.

- [ ] **Step 1: Replace the schema** (in `demo-video.ts`, same location as today):

```ts
const segmentAnchorSchema = z.union([
  z.literal("intro"),
  z.literal("outro"),
  z.number().int().min(0),
])

const narrationSegmentsSchema = z.object({
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      segments: z
        .array(
          z.object({
            text: z.string().describe("One short spoken sentence"),
            anchor: segmentAnchorSchema.describe(
              'What this line plays over: "intro" (opening frame, before any action), ' +
                'an action index from the numbered action list, or "outro" (final state)'
            ),
          })
        )
        .min(1)
        .max(8),
    })
  ),
})
```

- [ ] **Step 2: Replace `NARRATOR_INSTRUCTIONS`**:

```ts
const NARRATOR_INSTRUCTIONS = `You are the Demio narrator. You write voiceover narration for a recorded product demo, given each scene's goal, narration hint, and a numbered list of the browser actions the recorder performed.

Rules:
- Each segment is { text, anchor }. You NEVER schedule times — the sync engine times everything. anchor says what the line plays over:
  - "intro" — over the scene's opening frame, before any action happens. Use it to set context.
  - an action index (a number from the scene's numbered action list) — the line plays as that action happens on screen.
  - "outro" — over the scene's final state. Use it to land the outcome.
- List segments in playback order: intro lines first, then action-anchored lines in ascending action order, outro lines last. Multiple lines may share an anchor.
- One short conversational sentence per segment (~150 words per minute pacing — a sentence of 8-15 words). Match each scene's narrationHint for tone.
- Anchor to the FIRST action of a burst: typing then pressing Enter is one moment — anchor to the typing action's index.
- Output narration for every scene provided, even if brief. 2-6 segments per scene.`
```

- [ ] **Step 3: Rework the prompt body** in `narrateStep.execute` — replace the raw-JSONL inlining with a numbered action list (indices are the anchor space, so they must come from `parseActionEntries`, the same parser the EDL uses):

```ts
import { parseActionEntries } from "./sync"
// …
const actionLogs = await Promise.all(
  inputData.results.map(async (r) => {
    const entries = parseActionEntries(await fs.readFile(r.actionsPath, "utf8"))
    return {
      sceneId: r.sceneId,
      durationSec: r.durationSec,
      numberedActions: entries.map(
        (e) => `${e.idx}: ${e.action}${e.argsSummary ? ` ${e.argsSummary}` : ""}`
      ),
    }
  })
)
```

…and in the `narrator.generate` template, rename the `log` field to `actions: actionLogs.find(...)` (carrying `numberedActions` instead of raw JSONL). Everything else about `narrateStep` (gating, agent construction, structuredOutput) stays.

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: FAILS in `ttsStep` only (it still maps `seg.atSec` / calls `synthesizeSegments` — Task 6 territory). Confirm the errors are confined to `ttsStep`; any error elsewhere is a real bug in this task. (If executing tasks 5+6 as one branch-of-work session, run the check at Task 6's end instead.)

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/demo-video.ts
git commit -m "feat: narrator anchors segments to actions instead of scheduling times"
```

---

### Task 6: Workflow rewiring — tts synthesis-only, syncStep, compose simplification

**Files:**
- Modify: `electron/agent/workflows/demo-video.ts` (`ttsStep`, new `syncStep`, `composeStep`, workflow chain)
- Modify: `electron/agent/lib/voiceover.ts` (delete `synthesizeSegments`, `buildFfmpegMixArgs`, `VoiceSegment`, `SynthesizedVoiceover`, `SynthesizedSegmentDetail`, the clamp/overlap blocks — Task 4's deferred removal)

**Interfaces:**
- Consumes: `synthesizeNarrationAudio` (Task 4), `renderScene` (Task 3), narrator schema (Task 5).
- Produces: workflow chain `toScenes → foreach(record-scene) → collect → narrate → tts → sync → compose`; `composeStep` output schema unchanged (`{ videoPath, scenes }`) so `generate_demo`'s tool result and the renderer stay untouched.

- [ ] **Step 1: Rewrite `ttsStep`** — synthesis only, no ffmpeg, no mixing:

```ts
const sceneAudioSegmentSchema = z.object({
  text: z.string(),
  anchor: segmentAnchorSchema,
  file: z.string().describe("Workspace-relative MP3 path"),
  durationMs: z.number(),
})

const voicedSchema = narratedSchema.extend({
  sceneAudio: z.record(z.string(), z.array(sceneAudioSegmentSchema)).nullable(),
})

const ttsStep = createStep({
  id: "tts",
  inputSchema: narratedSchema,
  outputSchema: voicedSchema,
  execute: async ({ inputData, abortSignal }) => {
    if (!inputData.narration || !inputData.voiceId) {
      return { ...inputData, sceneAudio: null }
    }
    // Key re-read at execution time — never in workflow state (see
    // inputSchema comment).
    const elevenLabsKey = getDecryptedKey("elevenlabs")
    if (!elevenLabsKey) {
      return { ...inputData, sceneAudio: null }
    }

    const sceneAudio: Record<string, z.infer<typeof sceneAudioSegmentSchema>[]> = {}
    for (const sceneNarration of inputData.narration.scenes) {
      if (sceneNarration.segments.length === 0) continue
      if (!inputData.results.some((r) => r.sceneId === sceneNarration.sceneId)) continue
      const audio = await synthesizeNarrationAudio({
        cwd: inputData.workspace,
        sceneId: sceneNarration.sceneId,
        texts: sceneNarration.segments.map((s) => s.text),
        voiceId: inputData.voiceId,
        apiKey: elevenLabsKey,
        signal: abortSignal,
      })
      sceneAudio[sceneNarration.sceneId] = sceneNarration.segments.map((seg, i) => ({
        text: seg.text,
        anchor: seg.anchor,
        file: audio[i].file,
        durationMs: audio[i].durationMs,
      }))
    }
    return { ...inputData, sceneAudio }
  },
})
```

Delete the old `voicedPaths` concept and the ffmpeg require/`resolveFfmpeg` check from this step (compose still checks its own).

- [ ] **Step 2: Add `syncStep`** after `ttsStep`:

```ts
const syncedSchema = voicedSchema.extend({
  // sceneId → absolute path of the retimed, audio-carrying final scene file
  retimedPaths: z.record(z.string(), z.string()),
})

const syncStep = createStep({
  id: "sync",
  inputSchema: voicedSchema,
  outputSchema: syncedSchema,
  execute: async ({ inputData }) => {
    const retimedPaths: Record<string, string> = {}
    for (const r of inputData.results) {
      const rendered = await renderScene({
        workspace: inputData.workspace,
        sceneId: r.sceneId,
        videoPath: r.videoPath,
        actionsPath: r.actionsPath,
        segments: inputData.sceneAudio?.[r.sceneId] ?? [],
      })
      retimedPaths[r.sceneId] = rendered.finalPath
    }
    return { ...inputData, retimedPaths }
  },
})
```

(`renderScene` imported from `"./sync"`. No suspend/retry/degrade — see Global Constraints.)

- [ ] **Step 3: Simplify `composeStep`.** Every part now arrives as a uniform h264/yuv420p/30fps + 44100-stereo-aac `.final.mp4`, so the per-part normalization branch (the `anullsrc` transcode block) is deleted entirely:

```ts
const composeStep = createStep({
  id: "compose",
  inputSchema: syncedSchema,
  outputSchema: z.object({
    videoPath: z.string(),
    scenes: z.array(sceneResultSchema),
  }),
  execute: async ({ inputData }) => {
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) {
      throw new Error("ffmpeg binary not available — cannot compose the final demo video.")
    }
    const outDir = path.join(inputData.workspace, "output")
    await fs.mkdir(outDir, { recursive: true })

    // Every scene's final file was rendered by sync.ts with identical
    // codec/stream parameters (h264 yuv420p 30fps + aac 44100 stereo) —
    // the concat demuxer's uniformity requirement holds by construction
    // and the concat is a pure stream copy.
    const parts = inputData.results.map((r) => {
      const p = inputData.retimedPaths[r.sceneId]
      if (!p) throw new Error(`compose: no retimed output for ${r.sceneId}`)
      return p
    })

    const outputPath = path.join(outDir, "demo.mp4")
    const listPath = path.join(outDir, "concat.txt")
    await fs.writeFile(
      listPath,
      parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n")
    )
    await execFileAsync(ffmpeg, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart", outputPath,
    ])
    return { videoPath: outputPath, scenes: inputData.results }
  },
})
```

- [ ] **Step 4: Update the chain**:

```ts
export const demoVideoWorkflow = createWorkflow({
  id: "demo-video",
  inputSchema,
  outputSchema: composeStep.outputSchema,
})
  .then(toScenesStep)
  .foreach(sceneStep, { concurrency: 1 })
  .then(collectResultsStep)
  .then(narrateStep)
  .then(ttsStep)
  .then(syncStep)
  .then(composeStep)
  .commit()
```

- [ ] **Step 5: Finish Task 4's deferred deletion** in `lib/voiceover.ts`: remove `synthesizeSegments`, `buildFfmpegMixArgs`, `VoiceSegment`, `SynthesizedVoiceover`, `SynthesizedSegmentDetail`, the scene-end clamp and overlap blocks, and the now-unused `spawn`-based video probing of `sceneVideoPath`. Update the file header comment to describe the synthesis-only role.

- [ ] **Step 6: Verify**

Run: `bun run typecheck && bun run build && bun run test:workflows && grep -rn "synthesizeSegments\|voicedPaths\|atSec" electron/ src/ --include="*.ts" --include="*.tsx"`
Expected: all clean; grep returns NO hits (any hit = missed rewiring).

- [ ] **Step 7: Commit**

```bash
git add electron/agent/workflows/demo-video.ts electron/agent/lib/voiceover.ts
git commit -m "feat: wire sync/retiming step into demo-video workflow"
```

---

### Task 7: Live end-to-end verification + checklist update

**Files:**
- Modify: `docs/superpowers/plans/manual-e2e-checklist.md`

**Interfaces:** none — verification task.

- [ ] **Step 1: Full static gate**

Run: `bun run typecheck && bun run lint && bun run build && bun run test:workflows`
Expected: all clean.

- [ ] **Step 2: Offline render smoke test against the real archived run** (no app boot, no LLM, no ElevenLabs — exercises Task 3's renderer with real artifacts). Write a throwaway script in the scratchpad (NOT the repo) that imports nothing from the app; instead invoke `node` against the built pure module + ffmpeg by hand, or simpler — run this exact sequence and eyeball the output:

```bash
WORK=$(mktemp -d)
cp ~/.demio/workspaces/b12e11d4-8eaa-489d-8d3e-ac0cb39d7492/scenes/scene-01.webm "$WORK"/
cp ~/.demio/workspaces/b12e11d4-8eaa-489d-8d3e-ac0cb39d7492/scenes/scene-01.actions.jsonl "$WORK"/
node - "$WORK" <<'EOF'
const path = require("node:path")
const fs = require("node:fs")
const { execFileSync } = require("node:child_process")
const pure = require(path.resolve("electron/agent/workflows/edl-pure.cjs"))
const work = process.argv[2]
const jsonl = fs.readFileSync(path.join(work, "scene-01.actions.jsonl"), "utf8")
const entries = pure.parseActionEntries(jsonl)
const edl = pure.buildEdl({ actionEntries: entries, videoDurationMs: 40700, segments: [] })
console.log(JSON.stringify(pure.validateEdl(edl, 40700)))
console.log("slots:", edl.slots.length, "totalMs:", edl.totalMs)
edl.slots.forEach((s, i) => {
  const out = path.join(work, `slot-${i}.mp4`)
  execFileSync("ffmpeg", pure.buildSlotArgs(path.join(work, "scene-01.webm"), s, out), { stdio: "ignore" })
})
fs.writeFileSync(path.join(work, "concat.txt"), pure.buildConcatListText(edl.slots.map((_, i) => path.join(work, `slot-${i}.mp4`))))
execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", path.join(work, "concat.txt"), "-c", "copy", path.join(work, "retimed.mp4")], { stdio: "ignore" })
console.log("wrote", path.join(work, "retimed.mp4"))
EOF
ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/retimed.mp4"
```

Expected: `{"ok":true,"errors":[]}`; retimed duration ≈ `totalMs/1000` (±1s); **retimed duration well under 20s** vs the raw 40.7s. Open `"$WORK"/retimed.mp4` and confirm: no long static stretches, each typed todo appears with brief lead-in/out, intro/outro freezes look like a calm page (not a mid-motion smear).

- [ ] **Step 3: Live app run.** `bun start`, new thread, generate a TodoMVC demo with a voice configured. Confirm in the workspace: `scenes/*.edl.json` present, `scenes/*.final.mp4` per scene, `output/demo.mp4` total duration in the tens-of-seconds-tight range, narration audibly aligned with on-screen actions (voice about typing plays while typing is visible), no mid-word cutoffs, no >3s silent+static stretches.

- [ ] **Step 4: Voiceless live run.** Remove the project voice (or use a project without one), regenerate. Confirm the demo still renders retimed (idle cut) with silent audio track, and `edl.json` shows `segments: []`.

- [ ] **Step 5: Append to `manual-e2e-checklist.md`** a new "Milestone 2 — sync/retiming" section with the four checks from Steps 2-4 as user-facing checklist items (offline smoke optional; live voiced run, alignment listen-through, voiceless run, edl.json artifact presence).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/manual-e2e-checklist.md
git commit -m "docs: manual e2e checklist items for sync/retiming engine"
```

---

## Self-review notes

- **Spec coverage:** grilled decisions 1–10 all mapped: scope (non-goals section), narration-driven EDL (Task 2/6), deterministic builder (Task 2), anchor contract (Task 5), freeze holds (Task 2 `pushSlot`/Task 3 `tpad`), voiceless path (Task 2 test + Task 6 `segments: []` + Task 7 Step 4), persisted EDL (Task 3 Step 3), staged rendering (Task 3), pacing constants (EDL_DEFAULTS, recorded in edl.json via `opts`), validate-pre/hard-fail-post (Task 3 `validateEdl` throw + post-render drift check). Decisions 11–12 (branching/process) are execution context, not tasks.
- **Type consistency:** `SegmentAnchor`/`segmentAnchorSchema` shape (`"intro" | "outro" | number`) identical across Task 3 (`sync.ts`), Task 5 (schema), Task 6 (`sceneAudioSegmentSchema`). `renderScene` signature in Task 3 matches Task 6's call. `synthesizeNarrationAudio` signature in Task 4 matches Task 6's call. `parseActionEntries` re-export (Task 3) matches Task 5's import.
- **Known intentional wart:** Task 4/6 split of the `voiceover.ts` deletion (documented inline) keeps every task's tree green; Task 5 alone leaves typecheck red in `ttsStep` only — flagged in its verify step, and tasks 5+6 may be executed by one implementer session if the reviewer prefers a single green unit.
