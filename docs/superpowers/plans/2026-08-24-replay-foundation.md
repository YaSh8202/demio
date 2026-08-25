# Replay Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the on-camera recorder agent with a deterministic replay engine that executes a pre-proven script, recovers from deviations with the recording stopped, and verifies the resulting video as an artifact.

**Architecture:** A scene gains an executable `actions[]` script. `replay-pure.cjs` runs that script through an *injected* exec function — so the whole step loop is unit-testable with a fake — while `replay.ts` is a thin binding to the real `execAgentBrowser`. The harness picks the recording bracket per scene (`open` + `record start` for independent scenes, `record restart` for chained ones, which does not reload the page). On a deviation the harness stops the recording, runs a narrowly-bounded recovery agent off camera, and retakes the scene. Verification stops re-deriving process facts from the action log and checks the video file instead.

**Tech Stack:** TypeScript (Electron main), Zod, Mastra `@mastra/core@1.55.0`, agent-browser CLI, `ffmpeg-static`, `node --test`.

**Spec:** `docs/superpowers/plans/2026-08-23-rehearse-record-architecture.md` — read it first. This plan implements §1–4, §5, §13, §15 (deterministic half). Rehearsal (§6–12) and narration pacing (§14) are separate plans.

## Global Constraints

- Package manager is **bun**, never npm/npx. Tests: `bun run test:workflows`.
- Style: **no semicolons, double quotes, 2-space indent.** Prettier enforced (`.prettierrc`). `prettier-plugin-tailwindcss` is active — never hand-sort Tailwind classes.
- Strict TS: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` — use `import type` for type-only imports.
- **Pure logic goes in `.cjs`, tested by `node --test` via `*.test.js`.** Impure orchestration goes in `.ts` and is not unit-tested. This is the existing pattern (`verify-pure.cjs` / `verify.ts`, `edl-pure.cjs` / `sync.ts`). Follow it.
- Never import runtime code from `electron/` into `src/`.
- `execAgentBrowser(commands: string[], options?)` takes **ONE FULL COMMAND STRING per array element**. A single element is tokenized; multiple elements become `batch` mode. Variable parts must go through `shellQuote` from `electron/lib/agent-browser/quote`.
- `ExecResult` is `{ ok: boolean, output: string | Record<string, unknown>, error?: string, exitCode: number, durationMs: number }` (`electron/lib/agent-browser/exec.ts:19`).
- **There is no ffprobe.** The project ships `ffmpeg-static` only; duration and stream facts are parsed out of `ffmpeg -i` stderr (`electron/agent/lib/media-probe.ts`). Never add an ffprobe dependency.
- Typecheck with `bun run typecheck` before every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `electron/agent/workflows/script-schema.ts` | Zod contract for `ScriptedAction` / `SceneScript`. The interface every later task depends on. |
| **Create** `electron/agent/workflows/replay-pure.cjs` | Command building, deviation classification, expected-duration math, and the **step loop** with injected exec. All testable. |
| **Create** `electron/agent/workflows/replay-pure.test.js` | Unit tests for the above. |
| **Create** `electron/agent/workflows/replay.ts` | Thin TS binding: real `execAgentBrowser` + typed wrapper. |
| **Create** `electron/agent/workflows/artifact-pure.cjs` | Parsers for `blackdetect`, `freezedetect` and stream-table output — all read from ffmpeg's stderr. |
| **Create** `electron/agent/workflows/artifact-pure.test.js` | Unit tests for the parsers. |
| **Create** `electron/agent/workflows/artifact.ts` | Runs the two ffmpeg filter passes, returns the probe. |
| **Modify** `electron/agent/workflows/schemas.ts` | Drop `.max(12)`; add `script` to the scene; extend the check-name enum. |
| **Modify** `electron/agent/workflows/verify-pure.cjs` | Delete `parseActionsLog` / `checkEndUrl` usage from verification; add `checkComputedDuration`. |
| **Modify** `electron/agent/workflows/verify.ts` | Artifact-only. |
| **Modify** `electron/agent/workflows/record-scene.ts` | Replay replaces the recorder agent; continuity bracket; camera-off recovery. |
| **Modify** `electron/agent/prompts.ts` | `recorderInstructions()` → `recoveryInstructions()`, narrowly scoped. |
| **Modify** `docs/superpowers/plans/manual-e2e-checklist.md` | Add section E for the end-to-end replay walkthrough. |

---

### Task 1: The script contract

**Files:**
- Create: `electron/agent/workflows/script-schema.ts`
- Modify: `electron/agent/workflows/schemas.ts:41` (drop `.max(12)`), `schemas.ts:5-35` (add `script`)
- Test: `electron/agent/workflows/replay-pure.test.js` (created here, extended in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: `scriptedActionSchema`, `sceneScriptSchema`, and the types `ScriptedAction` = `{ cmd: string; assert?: string; settleMs: number; narrationAnchor?: number }`, `SceneScript` = `{ sceneId: string; continuity: "independent" | "chained"; oneShot: boolean; startUrl: string; endUrl: string; actions: ScriptedAction[] }`. Every later task imports these.

- [ ] **Step 1: Write the failing test**

Create `electron/agent/workflows/replay-pure.test.js`:

```js
const test = require("node:test")
const assert = require("node:assert")
const { normalizeScript } = require("./replay-pure.cjs")

test("normalizeScript: applies settleMs and continuity defaults", () => {
  const s = normalizeScript({
    sceneId: "scene-01",
    startUrl: "https://example.com",
    endUrl: "https://example.com/done",
    actions: [{ cmd: "click @e1" }],
  })
  assert.equal(s.continuity, "independent")
  assert.equal(s.oneShot, false)
  assert.equal(s.actions[0].settleMs, 600)
})

test("normalizeScript: preserves explicit values", () => {
  const s = normalizeScript({
    sceneId: "scene-02",
    continuity: "chained",
    oneShot: true,
    startUrl: "https://example.com",
    endUrl: "https://example.com/done",
    actions: [{ cmd: "click @e1", settleMs: 1500, assert: '--url "https://x"' }],
  })
  assert.equal(s.continuity, "chained")
  assert.equal(s.oneShot, true)
  assert.equal(s.actions[0].settleMs, 1500)
  assert.equal(s.actions[0].assert, '--url "https://x"')
})

test("normalizeScript: rejects a script with no actions", () => {
  assert.throws(
    () => normalizeScript({ sceneId: "s", startUrl: "u", endUrl: "u", actions: [] }),
    /at least one action/
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:workflows`
Expected: FAIL — `Cannot find module './replay-pure.cjs'`

- [ ] **Step 3: Write the pure defaults helper**

Create `electron/agent/workflows/replay-pure.cjs`:

```js
// Pure replay logic for the deterministic record pass. CommonJS so
// `node --test` runs it with zero build step (same pattern as
// verify-pure.cjs / edl-pure.cjs). No I/O — the step loop added in Task 2
// takes its exec function as a parameter.
"use strict"

const DEFAULT_SETTLE_MS = 600

/**
 * Apply defaults to a raw script object and validate the one invariant the
 * zod schema cannot express usefully at runtime in .cjs. Mirrors
 * `sceneScriptSchema` in script-schema.ts — keep the two in step.
 */
function normalizeScript(raw) {
  if (!raw || !Array.isArray(raw.actions) || raw.actions.length === 0) {
    throw new Error("script must have at least one action")
  }
  return {
    sceneId: String(raw.sceneId),
    continuity: raw.continuity === "chained" ? "chained" : "independent",
    oneShot: raw.oneShot === true,
    startUrl: String(raw.startUrl),
    endUrl: String(raw.endUrl),
    actions: raw.actions.map((a) => ({
      cmd: String(a.cmd),
      assert: typeof a.assert === "string" ? a.assert : undefined,
      settleMs:
        typeof a.settleMs === "number" ? a.settleMs : DEFAULT_SETTLE_MS,
      narrationAnchor:
        typeof a.narrationAnchor === "number" ? a.narrationAnchor : undefined,
    })),
  }
}

module.exports = { normalizeScript, DEFAULT_SETTLE_MS }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:workflows`
Expected: PASS — 3 passing in `replay-pure.test.js`

- [ ] **Step 5: Write the zod contract**

Create `electron/agent/workflows/script-schema.ts`:

```ts
// ── Scene script contract (rehearse → record) ────────────────────────────────
//
// The executable half of a scene. Rehearsal proves each action and emits this;
// the record pass replays it verbatim. Runtime defaults are mirrored in
// `replay-pure.cjs`'s `normalizeScript` — change both together.

import { z } from "zod"

export const scriptedActionSchema = z.object({
  cmd: z
    .string()
    .describe(
      'One full agent-browser command, e.g. `click \'form button[type="submit"]\'`. ' +
        "Must use a durable locator (role + name), never a snapshot ref like @e17 — " +
        "refs are resolved against a live RefMap that does not survive a page load."
    ),
  assert: z
    .string()
    .optional()
    .describe(
      "Arguments to `agent-browser wait` that prove this step landed, " +
        "e.g. `--url 'https://app.x.com/b/'` or `--text \"Saved\"`. " +
        "A missing assert means the step is unverified — allowed, but discouraged."
    ),
  settleMs: z
    .number()
    .default(600)
    .describe("Minimum dwell after the step, so the viewer sees the result"),
  narrationAnchor: z
    .number()
    .optional()
    .describe("Index of the narration segment that plays over this step"),
})
export type ScriptedAction = z.infer<typeof scriptedActionSchema>

export const sceneScriptSchema = z.object({
  sceneId: z.string(),
  continuity: z
    .enum(["independent", "chained"])
    .default("independent")
    .describe(
      "`chained` continues on the live page via `record restart` (no reload); " +
        "`independent` re-opens startUrl and starts a fresh recording context"
    ),
  oneShot: z
    .boolean()
    .default(false)
    .describe("This flow cannot be run twice — see the spec's §11"),
  startUrl: z.string(),
  endUrl: z
    .string()
    .describe("Observed during rehearsal, not guessed. Used to re-position on retry."),
  actions: z.array(scriptedActionSchema).min(1),
})
export type SceneScript = z.infer<typeof sceneScriptSchema>
```

- [ ] **Step 6: Attach the script to the scene and remove the cap**

In `electron/agent/workflows/schemas.ts`, add the import at the top (after the existing `import { z } from "zod"`):

```ts
import { sceneScriptSchema } from "./script-schema"
```

Add this field to `sceneSchema`, immediately after the `actions` field:

```ts
  script: sceneScriptSchema
    .optional()
    .describe(
      "Executable script produced by rehearsal. When present the record pass " +
        "replays it deterministically and `actions` is documentation only."
    ),
```

Change line 41 from:

```ts
  scenes: z.array(sceneSchema).min(1).max(12),
```

to:

```ts
  // No upper bound: scene count is a narrative decision the rehearsal agent
  // makes per demo. Long flows are split into consecutive `chained` scenes
  // rather than one long scene, which keeps the retake unit small.
  scenes: z.array(sceneSchema).min(1),
```

Extend the check-name enum on line 49 to carry the new artifact checks. **Keep `actions-ok` and `end-url`** even though Task 5 stops emitting them: `verifyReportSchema` also parses `SceneResult` rows already persisted in the file store, and removing the members would fail validation on every run recorded before this change.

```ts
      name: z.enum([
        "video-exists",
        "duration-range",
        "actions-ok",
        "end-url",
        "black-frames",
        "freeze-frames",
        "audio-track",
      ]),
```

- [ ] **Step 7: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add electron/agent/workflows/script-schema.ts \
        electron/agent/workflows/replay-pure.cjs \
        electron/agent/workflows/replay-pure.test.js \
        electron/agent/workflows/schemas.ts
git commit -m "feat: add the scene script contract and lift the 12-scene cap"
```

---

### Task 2: Deviation classification and the step loop

**Files:**
- Modify: `electron/agent/workflows/replay-pure.cjs`
- Test: `electron/agent/workflows/replay-pure.test.js`

**Interfaces:**
- Consumes: `normalizeScript` from Task 1.
- Produces:
  - `buildStepCommands(action) -> string[]` — the agent-browser command strings for one step.
  - `classifyStep({ cmdResult, assertResult }) -> { status: "ok" | "deviation", detail: string }`
  - `expectedDurationMs(script) -> number`
  - `runScript({ script, exec, onStep, signal }) -> Promise<{ status: "ok" | "deviation", steps: Array<{ index, cmd, status, detail, durationMs }>, deviation?: { index, cmd, detail } }>` — Task 3 and Task 7 both call this.

- [ ] **Step 1: Write the failing tests**

Append to `electron/agent/workflows/replay-pure.test.js`:

```js
const {
  buildStepCommands,
  classifyStep,
  expectedDurationMs,
  runScript,
} = require("./replay-pure.cjs")

test("buildStepCommands: bare action is one command", () => {
  const cmds = buildStepCommands({ cmd: "click @e1", settleMs: 600 })
  assert.deepEqual(cmds, ["click @e1"])
})

test("buildStepCommands: assert becomes a following wait command", () => {
  const cmds = buildStepCommands({
    cmd: "click @e1",
    assert: '--url "https://x/b/"',
    settleMs: 600,
  })
  assert.deepEqual(cmds, ["click @e1", 'wait --url "https://x/b/"'])
})

test("classifyStep: command failure is a deviation", () => {
  const r = classifyStep({
    cmdResult: { ok: false, error: "Element not found" },
    assertResult: null,
  })
  assert.equal(r.status, "deviation")
  assert.match(r.detail, /Element not found/)
})

test("classifyStep: assertion failure is a deviation even when the command succeeded", () => {
  const r = classifyStep({
    cmdResult: { ok: true, output: "" },
    assertResult: { ok: false, error: "timeout waiting for url" },
  })
  assert.equal(r.status, "deviation")
  assert.match(r.detail, /assertion/)
})

test("classifyStep: both clean is ok", () => {
  const r = classifyStep({
    cmdResult: { ok: true, output: "" },
    assertResult: { ok: true, output: "" },
  })
  assert.equal(r.status, "ok")
})

test("expectedDurationMs: sums settle time plus a per-action baseline", () => {
  const script = normalizeScript({
    sceneId: "s",
    startUrl: "u",
    endUrl: "u",
    actions: [{ cmd: "a", settleMs: 1000 }, { cmd: "b", settleMs: 2000 }],
  })
  // 3000ms settle + 2 * 400ms baseline = 3800
  assert.equal(expectedDurationMs(script), 3800)
})

test("runScript: every step ok returns ok with one entry per action", async () => {
  const seen = []
  const exec = async (cmds) => {
    seen.push(cmds[0])
    return { ok: true, output: "", exitCode: 0, durationMs: 10 }
  }
  const script = normalizeScript({
    sceneId: "s",
    startUrl: "u",
    endUrl: "u",
    actions: [{ cmd: "click @e1", settleMs: 0 }, { cmd: "click @e2", settleMs: 0 }],
  })
  const r = await runScript({ script, exec })
  assert.equal(r.status, "ok")
  assert.equal(r.steps.length, 2)
  assert.deepEqual(seen, ["click @e1", "click @e2"])
})

test("runScript: stops at the first deviation and reports its index", async () => {
  const exec = async (cmds) =>
    cmds[0] === "click @e2"
      ? { ok: false, error: "Element not found", exitCode: 1, durationMs: 5 }
      : { ok: true, output: "", exitCode: 0, durationMs: 5 }
  const script = normalizeScript({
    sceneId: "s",
    startUrl: "u",
    endUrl: "u",
    actions: [
      { cmd: "click @e1", settleMs: 0 },
      { cmd: "click @e2", settleMs: 0 },
      { cmd: "click @e3", settleMs: 0 },
    ],
  })
  const r = await runScript({ script, exec })
  assert.equal(r.status, "deviation")
  assert.equal(r.deviation.index, 1)
  assert.equal(r.deviation.cmd, "click @e2")
  // step 3 must not have run
  assert.equal(r.steps.length, 2)
})

test("runScript: an aborted signal stops before the next step", async () => {
  const controller = new AbortController()
  const exec = async () => {
    controller.abort()
    return { ok: true, output: "", exitCode: 0, durationMs: 1 }
  }
  const script = normalizeScript({
    sceneId: "s",
    startUrl: "u",
    endUrl: "u",
    actions: [{ cmd: "a", settleMs: 0 }, { cmd: "b", settleMs: 0 }],
  })
  const r = await runScript({ script, exec, signal: controller.signal })
  assert.equal(r.steps.length, 1)
  assert.equal(r.status, "aborted")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:workflows`
Expected: FAIL — `buildStepCommands is not a function`

- [ ] **Step 3: Implement the loop**

Replace the `module.exports` line in `electron/agent/workflows/replay-pure.cjs` and add above it:

```js
/**
 * Per-action baseline: the wall-clock a command costs beyond its settle
 * time (CDP round trip, cursor animation, typing jitter). Used only to
 * predict a take's length for the duration check — never to pace replay.
 */
const ACTION_BASELINE_MS = 400

/** The agent-browser command strings one scripted step expands to. */
function buildStepCommands(action) {
  const cmds = [action.cmd]
  if (action.assert) cmds.push(`wait ${action.assert}`)
  return cmds
}

/**
 * Decide whether one step landed. A command that errored is a deviation;
 * so is a command that succeeded while its assertion failed — that second
 * case is the one today's `actions-ok` check cannot see, because
 * agent-browser logs a click on the wrong element as `ok: true`.
 */
function classifyStep({ cmdResult, assertResult }) {
  if (!cmdResult || cmdResult.ok !== true) {
    return {
      status: "deviation",
      detail: `command failed: ${(cmdResult && cmdResult.error) || "unknown error"}`,
    }
  }
  if (assertResult && assertResult.ok !== true) {
    return {
      status: "deviation",
      detail: `assertion failed: ${assertResult.error || "unknown error"}`,
    }
  }
  return { status: "ok", detail: "" }
}

/** Predicted length of a clean take, in ms. */
function expectedDurationMs(script) {
  return script.actions.reduce(
    (sum, a) => sum + a.settleMs + ACTION_BASELINE_MS,
    0
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Replay a scene script. `exec` is injected so the whole loop is testable
 * without a browser — production passes a binding of `execAgentBrowser`.
 *
 * Stops at the FIRST deviation: the caller's job is to stop the recording,
 * recover off camera, and retake. Continuing past a deviation would put the
 * fumbling on tape, which is the thing this design exists to prevent.
 */
async function runScript({ script, exec, onStep, signal }) {
  const steps = []
  for (let index = 0; index < script.actions.length; index++) {
    if (signal && signal.aborted) {
      return { status: "aborted", steps }
    }
    const action = script.actions[index]
    const started = Date.now()

    const [cmdString, assertString] = buildStepCommands(action)
    const cmdResult = await exec([cmdString], { timeout: 30_000 })
    let assertResult = null
    if (assertString && cmdResult.ok === true) {
      assertResult = await exec([assertString], { timeout: 15_000 })
    }

    const verdict = classifyStep({ cmdResult, assertResult })
    const entry = {
      index,
      cmd: action.cmd,
      status: verdict.status,
      detail: verdict.detail,
      durationMs: Date.now() - started,
    }
    steps.push(entry)
    if (onStep) onStep(entry)

    if (verdict.status === "deviation") {
      return {
        status: "deviation",
        steps,
        deviation: { index, cmd: action.cmd, detail: verdict.detail },
      }
    }

    if (action.settleMs > 0) await sleep(action.settleMs)
  }
  if (signal && signal.aborted) return { status: "aborted", steps }
  return { status: "ok", steps }
}

module.exports = {
  normalizeScript,
  buildStepCommands,
  classifyStep,
  expectedDurationMs,
  runScript,
  DEFAULT_SETTLE_MS,
  ACTION_BASELINE_MS,
}
```

Delete the old `module.exports = { normalizeScript, DEFAULT_SETTLE_MS }` line from Task 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:workflows`
Expected: PASS — 11 passing in `replay-pure.test.js`

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/replay-pure.cjs electron/agent/workflows/replay-pure.test.js
git commit -m "feat: deterministic replay loop with per-step assertions"
```

---

### Task 3: Bind replay to the real CLI

**Files:**
- Create: `electron/agent/workflows/replay.ts`

**Interfaces:**
- Consumes: `runScript`, `normalizeScript`, `expectedDurationMs` from Task 2; `SceneScript` from Task 1.
- Produces: `replayScene(opts: { script: SceneScript; signal?: AbortSignal; onStep?: (s: ReplayStep) => void }) => Promise<ReplayOutcome>` where `ReplayStep = { index: number; cmd: string; status: "ok" | "deviation"; detail: string; durationMs: number }` and `ReplayOutcome = { status: "ok" | "deviation" | "aborted"; steps: ReplayStep[]; deviation?: { index: number; cmd: string; detail: string } }`. Also re-exports `expectedDurationMs`. Task 7 and Task 8 both import from here, never from the `.cjs` directly.

- [ ] **Step 1: Write the binding**

Create `electron/agent/workflows/replay.ts`:

```ts
// ── Replay engine binding ────────────────────────────────────────────────────
//
// Thin TS wrapper over `replay-pure.cjs`. All decision logic lives in the
// .cjs (and is unit-tested there); this file only supplies the real exec
// function and the types. Same split as sync.ts / edl-pure.cjs.

import { createRequire } from "node:module"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import type { SceneScript } from "./script-schema"

const require = createRequire(import.meta.url)

export interface ReplayStep {
  index: number
  cmd: string
  status: "ok" | "deviation"
  detail: string
  durationMs: number
}

export interface ReplayOutcome {
  status: "ok" | "deviation" | "aborted"
  steps: ReplayStep[]
  deviation?: { index: number; cmd: string; detail: string }
}

const pure = require("./replay-pure.cjs") as {
  runScript: (o: {
    script: SceneScript
    exec: typeof execAgentBrowser
    onStep?: (s: ReplayStep) => void
    signal?: AbortSignal
  }) => Promise<ReplayOutcome>
  expectedDurationMs: (s: SceneScript) => number
  normalizeScript: (raw: unknown) => SceneScript
}

/** Predicted length of a clean take, in ms. */
export function expectedDurationMs(script: SceneScript): number {
  return pure.expectedDurationMs(script)
}

/**
 * Replay one scene's script against the live browser. Stops at the first
 * deviation — the caller stops the recording and recovers off camera.
 */
export async function replayScene(opts: {
  script: SceneScript
  signal?: AbortSignal
  onStep?: (step: ReplayStep) => void
}): Promise<ReplayOutcome> {
  return pure.runScript({
    script: opts.script,
    exec: execAgentBrowser,
    onStep: opts.onStep,
    signal: opts.signal,
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add electron/agent/workflows/replay.ts
git commit -m "feat: bind the replay loop to the agent-browser CLI"
```

---

### Task 4: Artifact probe parsers

**Files:**
- Create: `electron/agent/workflows/artifact-pure.cjs`
- Test: `electron/agent/workflows/artifact-pure.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseBlackDetect(stderr) -> Array<{ startSec, endSec, durationSec }>`
  - `parseFreezeDetect(stderr) -> Array<{ startSec, durationSec }>`
  - `hasAudioStream(ffmpegStderr) -> boolean` — reads the `Stream #0:1: Audio:` line out of `ffmpeg -i` output. **There is no ffprobe in this project** — only `ffmpeg-static`; `probeDurationSec` already parses `ffmpeg -i` stderr the same way (`electron/agent/lib/media-probe.ts`). Do not add an ffprobe dependency.
  - `checkBlackFrames(spans, videoDurationSec) -> { ok, detail }` — fails only when black covers **more than half** the recording.
  - `checkComputedDuration(actualSec, expectedSec, tolerance) -> { ok, detail }`

- [ ] **Step 1: Write the failing tests**

Create `electron/agent/workflows/artifact-pure.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:workflows`
Expected: FAIL — `Cannot find module './artifact-pure.cjs'`

- [ ] **Step 3: Implement the parsers**

Create `electron/agent/workflows/artifact-pure.cjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:workflows`
Expected: PASS — 10 passing in `artifact-pure.test.js`

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/artifact-pure.cjs electron/agent/workflows/artifact-pure.test.js
git commit -m "feat: parsers for blackdetect, freezedetect and audio-stream detection"
```

---

### Task 5: Run the probes and rewrite verification

**Files:**
- Create: `electron/agent/workflows/artifact.ts`
- Modify: `electron/agent/workflows/verify.ts` (whole file)
- Modify: `electron/agent/workflows/verify-pure.cjs` (remove the clamp path)
- Modify: `electron/agent/workflows/verify.test.js` (drop tests for deleted behaviour)

**Interfaces:**
- Consumes: `artifact-pure.cjs` exports from Task 4; `expectedDurationMs` from Task 3; `probeDurationSec` from `../lib/media-probe`; `resolveFfmpeg` from `../../lib/ffmpeg`. **No ffprobe** — this project ships only `ffmpeg-static`.
- Produces: `probeArtifact(videoPath: string) => Promise<{ durationSec: number; blackSpans; freezeSpans; hasAudio: boolean }>` and a rewritten `verifyScene(input: { script: SceneScript; videoPath: string; voiceExpected: boolean }) => Promise<VerifyReport>`. Task 8 calls the new `verifyScene`.

**Important:** the probes run on the **raw scene recording**, not on the retimed `.final.mp4`. The retimer inserts freeze-holds deliberately (`edl-pure.cjs`), so running `freezedetect` after sync would flag intentional output as a defect.

- [ ] **Step 1: Write the probe runner**

Create `electron/agent/workflows/artifact.ts`:

```ts
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
```

- [ ] **Step 2: Confirm no ffprobe is needed**

Run: `grep -n "export function resolve" electron/lib/ffmpeg.ts`
Expected: exactly one resolver, `resolveFfmpeg`. There is no `resolveFfprobe`, and none should be added — `artifact.ts` reads everything it needs from ffmpeg's stderr, the same trick `probeDurationSec` uses (`electron/agent/lib/media-probe.ts`).

Do **not** run `bun add ffprobe-static`. If a later task appears to need ffprobe, that is a signal the parser should read `ffmpeg -i` stderr instead.

- [ ] **Step 3: Rewrite verifyScene as artifact-only**

Replace the entire contents of `electron/agent/workflows/verify.ts`:

```ts
// ── Scene artifact verification ──────────────────────────────────────────────
//
// Verification checks the FILE, not the process. Whether every step ran and
// asserted clean is known by the replay engine in real time (see replay.ts)
// and acted on immediately — re-deriving it from the action log afterwards
// would be asking the same question from worse evidence.
//
// Replaces the old four checks: `actions-ok` and `end-url` moved into replay
// as per-step assertions, and `duration-range` became a computed check now
// that a take's length is predictable (the old planner-guessed range had to
// be clamped up to 120s because raw recordings carried LLM think-time).

import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { probeArtifact } from "./artifact"
import { expectedDurationMs } from "./replay"
import type { SceneScript } from "./script-schema"
import type { VerifyReport } from "./schemas"

const require = createRequire(import.meta.url)

const pure = require("./artifact-pure.cjs") as {
  checkBlackFrames: (
    spans: Array<{ durationSec: number }>,
    videoDurationSec: number
  ) => { ok: boolean; detail: string }
  checkComputedDuration: (
    actualSec: number,
    expectedSec: number,
    tolerance?: number
  ) => { ok: boolean; detail: string }
}

export interface VerifyInput {
  script: SceneScript
  videoPath: string
  /** True when a voice is configured, so a missing audio track is a defect. */
  voiceExpected: boolean
}

export async function verifyScene(input: VerifyInput): Promise<VerifyReport> {
  const checks: VerifyReport["checks"] = []

  let exists = false
  try {
    const stat = await fs.stat(input.videoPath)
    exists = stat.size > 0
  } catch {
    exists = false
  }
  checks.push({
    name: "video-exists",
    ok: exists,
    detail: exists ? input.videoPath : `missing or empty: ${input.videoPath}`,
  })

  if (!exists) {
    for (const name of ["duration-range", "black-frames", "freeze-frames"] as const) {
      checks.push({ name, ok: false, detail: "skipped: no video" })
    }
    return { ok: false, checks }
  }

  try {
    const probe = await probeArtifact(input.videoPath)

    const dur = pure.checkComputedDuration(
      probe.durationSec,
      expectedDurationMs(input.script) / 1000
    )
    checks.push({ name: "duration-range", ok: dur.ok, detail: dur.detail })

    const black = pure.checkBlackFrames(probe.blackSpans, probe.durationSec)
    checks.push({ name: "black-frames", ok: black.ok, detail: black.detail })

    // Informational: a deterministic dwell on a settled page is a static
    // image but not a defect, so a freeze never fails the scene on its own.
    // It is surfaced so a human reviewing a bad take can see it.
    checks.push({
      name: "freeze-frames",
      ok: true,
      detail:
        probe.freezeSpans.length === 0
          ? "no freezes over 4s"
          : `${probe.freezeSpans.length} freeze span(s) over 4s: ` +
            probe.freezeSpans
              .map((f) => `${f.startSec.toFixed(1)}s for ${f.durationSec.toFixed(1)}s`)
              .join(", "),
    })

    if (input.voiceExpected) {
      checks.push({
        name: "audio-track",
        ok: probe.hasAudio,
        detail: probe.hasAudio
          ? "audio track present"
          : "a voice was configured but the recording has no audio track",
      })
    }
  } catch (err) {
    checks.push({
      name: "duration-range",
      ok: false,
      detail: `could not probe: ${(err as Error).message}`,
    })
  }

  return { ok: checks.every((c) => c.ok), checks }
}
```

- [ ] **Step 4: Remove the superseded pure helpers and their tests**

In `electron/agent/workflows/verify-pure.cjs`, delete `checkDurationRange`, `checkEndUrl` and `normalizeUrl`, and reduce the export to:

```js
module.exports = { parseActionsLog }
```

`parseActionsLog` stays — `edl-pure.cjs` has its own copy for the sync engine, but `parseActionsLog` here is still the thing that reports a malformed log, and Task 8 uses it to assert the log's step count.

In `electron/agent/workflows/verify.test.js`, delete every `checkDurationRange` and `checkEndUrl` test and remove them from the `require` destructure at the top, leaving only:

```js
const { parseActionsLog } = require("./verify-pure.cjs")
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun run test:workflows`
Expected: PASS — `verify.test.js` now has only the three `parseActionsLog` tests; `artifact-pure.test.js` and `replay-pure.test.js` all pass.

Run: `bun run typecheck`
Expected: errors in `record-scene.ts` only (it still calls the old `verifyScene` signature). Task 8 fixes those. Do **not** patch them here.

- [ ] **Step 6: Commit**

```bash
git add electron/agent/workflows/artifact.ts \
        electron/agent/workflows/verify.ts \
        electron/agent/workflows/verify-pure.cjs \
        electron/agent/workflows/verify.test.js
git commit -m "feat: artifact-level scene verification, drop the 120s duration clamp"
```

---

### Task 6: The recording bracket

**Files:**
- Modify: `electron/agent/workflows/replay-pure.cjs`
- Test: `electron/agent/workflows/replay-pure.test.js`

**Interfaces:**
- Consumes: `SceneScript` shape from Task 1.
- Produces: `recordingBracket({ script, videoPath, actionsPath, isRetry }) -> { commands: string[], resetsPage: boolean }`. Task 8 calls it to decide how to open a take.

Background, verified in the agent-browser source:
- `handle_recording_start` (`native/actions.rs:4528`) creates a **fresh browser context**, opens `about:blank`, then `Page.navigate`s. In-page state is lost; cookies and localStorage survive.
- `handle_recording_restart` (`native/actions.rs:4719`) creates no context and never navigates — it re-attaches frame capture to `browser.active_session_id()`. In-page state survives.
- `record restart <path> <url>` **parses the URL and silently ignores it** — the handler never reads `cmd.get("url")`. Never rely on restart to navigate.

- [ ] **Step 1: Write the failing tests**

Append to `electron/agent/workflows/replay-pure.test.js`:

```js
const { recordingBracket } = require("./replay-pure.cjs")

test("recordingBracket: independent scene opens the start URL then starts", () => {
  const script = normalizeScript({
    sceneId: "scene-01",
    continuity: "independent",
    startUrl: "https://example.com/boards",
    endUrl: "https://example.com/b/1",
    actions: [{ cmd: "click @e1" }],
  })
  const b = recordingBracket({
    script,
    videoPath: "/w/scenes/scene-01.webm",
    actionsPath: "/w/scenes/scene-01.actions.jsonl",
    isRetry: false,
  })
  assert.equal(b.resetsPage, true)
  assert.equal(b.commands.length, 2)
  assert.match(b.commands[0], /^open /)
  assert.match(b.commands[1], /^record start /)
  assert.match(b.commands[1], /--log-actions/)
})

test("recordingBracket: chained scene restarts without navigating", () => {
  const script = normalizeScript({
    sceneId: "scene-02",
    continuity: "chained",
    startUrl: "https://example.com/b/1",
    endUrl: "https://example.com/b/1",
    actions: [{ cmd: "click @e1" }],
  })
  const b = recordingBracket({
    script,
    videoPath: "/w/scenes/scene-02.webm",
    actionsPath: "/w/scenes/scene-02.actions.jsonl",
    isRetry: false,
  })
  assert.equal(b.resetsPage, false)
  assert.equal(b.commands.length, 1)
  assert.match(b.commands[0], /^record restart /)
  assert.match(b.commands[0], /--log-actions/)
})

test("recordingBracket: a chained scene falls back to open+start on retry", () => {
  const script = normalizeScript({
    sceneId: "scene-02",
    continuity: "chained",
    startUrl: "https://example.com/b/1",
    endUrl: "https://example.com/b/1",
    actions: [{ cmd: "click @e1" }],
  })
  const b = recordingBracket({
    script,
    videoPath: "/w/scenes/scene-02.webm",
    actionsPath: "/w/scenes/scene-02.actions.jsonl",
    isRetry: true,
  })
  assert.equal(b.resetsPage, true)
  assert.equal(b.commands.length, 2)
  assert.match(b.commands[0], /^open /)
})

test("recordingBracket: quotes paths containing spaces", () => {
  const script = normalizeScript({
    sceneId: "scene-03",
    startUrl: "https://example.com",
    endUrl: "https://example.com",
    actions: [{ cmd: "click @e1" }],
  })
  const b = recordingBracket({
    script,
    videoPath: "/my workspace/scenes/scene-03.webm",
    actionsPath: "/my workspace/scenes/scene-03.actions.jsonl",
    isRetry: false,
  })
  assert.match(b.commands[1], /'\/my workspace\/scenes\/scene-03\.webm'/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:workflows`
Expected: FAIL — `recordingBracket is not a function`

- [ ] **Step 3: Implement the bracket, with its own quoting**

`replay-pure.cjs` must stay dependency-free so `node --test` can load it, so it carries a local copy of the quoting rule rather than importing `electron/lib/agent-browser/quote`.

Add to `electron/agent/workflows/replay-pure.cjs`:

```js
/**
 * Single-quote a value for agent-browser's `splitCommand` tokenizer, so
 * paths and URLs containing spaces survive. Mirrors
 * `electron/lib/agent-browser/quote.ts` — this file must stay import-free so
 * `node --test` can load it directly, hence the duplicate.
 */
function quoteArg(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/**
 * The command(s) that open a take.
 *
 * A `chained` scene uses `record restart`, which re-attaches frame capture to
 * the live page without creating a browser context or navigating — verified
 * in agent-browser's `handle_recording_restart` (native/actions.rs:4719).
 * `record start`, by contrast, creates a fresh context and navigates
 * (native/actions.rs:4528), losing in-page state.
 *
 * A retry always falls back to open+start: scene N's half-executed wreckage
 * is not a valid start state, so continuity is traded for idempotency on
 * that take only.
 *
 * NOTE: `record restart <path> <url>` parses the URL and then ignores it —
 * the handler never reads it. Never use restart to navigate.
 */
function recordingBracket({ script, videoPath, actionsPath, isRetry }) {
  const logFlag = `--log-actions ${quoteArg(actionsPath)}`
  if (script.continuity === "chained" && !isRetry) {
    return {
      commands: [`record restart ${quoteArg(videoPath)} ${logFlag}`],
      resetsPage: false,
    }
  }
  return {
    commands: [
      `open ${quoteArg(script.startUrl)}`,
      `record start ${quoteArg(videoPath)} ${logFlag}`,
    ],
    resetsPage: true,
  }
}
```

Add `recordingBracket` and `quoteArg` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:workflows`
Expected: PASS — 15 passing in `replay-pure.test.js`

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/replay-pure.cjs electron/agent/workflows/replay-pure.test.js
git commit -m "feat: per-scene recording bracket with chained continuity"
```

---

### Task 7: The recovery agent

**Files:**
- Modify: `electron/agent/prompts.ts:446-506` (replace `recorderInstructions` with `recoveryInstructions`)
- Create: `electron/agent/workflows/recovery.ts`

**Interfaces:**
- Consumes: `createDemioAgent` from `../demio-agent`; `ReplayOutcome` from Task 3.
- Produces: `recoverFromDeviation(opts: { workspace: string; modelId: string; script: SceneScript; deviation: { index: number; cmd: string; detail: string }; signal: AbortSignal }) => Promise<{ recovered: boolean; detail: string }>`. Task 8 calls it between `record stop` and the retake.

**The constraint that makes the whole design work:** recovery may only clear obstacles. If it performs any of the scene's own scripted actions, the retake starts from a state where part of the work is already done — which breaks the retake *and* desynchronises narration anchors from the action log.

- [ ] **Step 1: Replace the recorder prompt with a recovery prompt**

In `electron/agent/prompts.ts`, replace the `RecorderInstructionsContext` interface and the whole `recorderInstructions` function (lines 446 to end of file, keeping the trailing `agentBrowserSkill` interpolation pattern) with:

```ts
export interface RecoveryInstructionsContext {
  workspace: string
  script: SceneScript
  deviation: { index: number; cmd: string; detail: string }
}

/**
 * The recovery agent runs with the recording STOPPED. Its only job is to
 * clear whatever blocked a scripted step so the scene can be retaken
 * cleanly. It must never perform the scene's own actions: the retake replays
 * the script from step 0, so any progress this agent makes turns into
 * duplicate work ("board already exists") on the retake, and desynchronises
 * the action log from the script the narration anchors reference.
 */
export function recoveryInstructions(ctx: RecoveryInstructionsContext): string {
  const { workspace, script, deviation } = ctx

  const scriptList = script.actions
    .map((a, i) => `${i}. ${a.cmd}${i === deviation.index ? "   ← FAILED HERE" : ""}`)
    .join("\n")

  return `You are the Demio recovery agent. A scripted demo step failed. **The screen recording is currently STOPPED** — nothing you do now appears in the video.

The script being replayed:

${scriptList}

Step ${deviation.index} (\`${deviation.cmd}\`) failed: ${deviation.detail}

# Your only job

Clear whatever is blocking that step, then stop. The scene will be retaken from step 0 immediately after you finish.

**You MAY**: dismiss a cookie banner or modal, close an overlay, scroll an element into view, wait for a slow render, reload the page, or navigate back to \`${script.startUrl}\`.

**You MUST NOT** run any command from the script above, or anything equivalent to one. Do not click Create. Do not fill the form. Do not advance the flow. If you complete part of the scene, the retake will replay those steps again and fail on duplicated work.

Use at most 3 commands. If 3 commands cannot clear it, stop and report failure — an unrecoverable blocker is a better outcome than a corrupted starting state.

# Tools

\`mastra_workspace_execute_command\` only. Every call MUST pass a \`description\` — a clear 5-10 word summary shown as the shell card's title.

Files live in \`${workspace}\`; \`$WORKSPACE\` is set in the shell environment.

# Locators

Prefer a fresh \`agent-browser snapshot -i\` then \`click @eN\`, or \`find role button --name "..." --exact\`. Never \`find text\` for a clickable control, and never \`find nth\` with a positional guess.

# Reply

Reply exactly \`CLEARED: <what you did>\` if the blocker is gone, or exactly \`BLOCKED: <one-line reason>\` if it is not. Your reply IS read — it decides whether the scene is retaken or escalated to the user.

# agent-browser CLI reference

${agentBrowserSkill}
`
}
```

Add the import for the new type at the top of `prompts.ts`, alongside the existing `import type { Scene } from "./workflows/schemas"`:

```ts
import type { SceneScript } from "./workflows/script-schema"
```

If `Scene` becomes unused after this replacement, delete that import — `noUnusedLocals` is on.

- [ ] **Step 2: Write the recovery runner**

Create `electron/agent/workflows/recovery.ts`:

```ts
// ── Camera-off recovery ──────────────────────────────────────────────────────
//
// Runs between `record stop` and the retake, so its fumbling never reaches
// the video. Deliberately narrow: see recoveryInstructions() for why it must
// not perform the scene's own steps.

import { WORKSPACE_TOOLS } from "@mastra/core/workspace"
import { createDemioAgent } from "../demio-agent"
import { recoveryInstructions } from "../prompts"
import type { SceneScript } from "./script-schema"
import log from "../../lib/logger"

/** Shell only — recovery reads and writes nothing on disk. */
const RECOVERY_TOOL_FILTER = [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]

/** Hard ceiling matching the prompt's "at most 3 commands". */
const RECOVERY_MAX_STEPS = 6

export async function recoverFromDeviation(opts: {
  workspace: string
  modelId: string
  script: SceneScript
  deviation: { index: number; cmd: string; detail: string }
  signal: AbortSignal
}): Promise<{ recovered: boolean; detail: string }> {
  try {
    const agent = createDemioAgent({
      workspace: opts.workspace,
      modelId: opts.modelId,
      toolFilter: RECOVERY_TOOL_FILTER,
      instructionsOverride: recoveryInstructions({
        workspace: opts.workspace,
        script: opts.script,
        deviation: opts.deviation,
      }),
    })
    const res = await agent.generate(
      `Clear the blocker on step ${opts.deviation.index} of ${opts.script.sceneId}.`,
      { abortSignal: opts.signal, maxSteps: RECOVERY_MAX_STEPS }
    )
    const text = (res.text ?? "").trim()
    // Unlike the old recorder's DONE/STUCK protocol — which nothing ever
    // parsed — this reply is genuinely read: it decides retake vs escalate.
    if (text.startsWith("CLEARED")) {
      return { recovered: true, detail: text }
    }
    return { recovered: false, detail: text || "recovery agent returned nothing" }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log.warn(`[demo-workflow] recovery agent failed: ${detail}`)
    return { recovered: false, detail: `recovery agent error: ${detail}` }
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: errors in `record-scene.ts` only (it still imports `recorderInstructions`). Task 8 fixes those.

- [ ] **Step 4: Commit**

```bash
git add electron/agent/prompts.ts electron/agent/workflows/recovery.ts
git commit -m "feat: bounded camera-off recovery agent replacing the recorder"
```

---

### Task 8: Rewire the scene step

**Files:**
- Modify: `electron/agent/workflows/record-scene.ts` (whole file)
- Modify: `electron/agent/workflows/demo-video.ts:161-173` (pass `voiceExpected`)

**Interfaces:**
- Consumes: `recordingBracket`, `replayScene`, `expectedDurationMs` (Tasks 2/3/6), `verifyScene` (Task 5), `recoverFromDeviation` (Task 7).
- Produces: `recordSceneWithRetry` keeps its existing call signature and return shape — `{ status: "done"; result: SceneResult } | { status: "failed"; lastReport: VerifyReport; attempts: number }` — so `demo-video.ts`'s `sceneStep` needs no structural change. It gains one required option: `voiceExpected: boolean`.

- [ ] **Step 1: Replace the attempt body**

In `electron/agent/workflows/record-scene.ts`:

Replace the imports of `createDemioAgent`, `recorderInstructions` and `WORKSPACE_TOOLS`, and delete `RECORDER_TOOL_FILTER` and `currentUrl()`. The new import block is:

```ts
import path from "node:path"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import { replayScene } from "./replay"
import { recoverFromDeviation } from "./recovery"
import { verifyScene } from "./verify"
import type { Scene, SceneResult, VerifyReport } from "./schemas"
import type { SceneScript } from "./script-schema"
import log from "../../lib/logger"

const require = createRequire(import.meta.url)
const pure = require("./replay-pure.cjs") as {
  recordingBracket: (o: {
    script: SceneScript
    videoPath: string
    actionsPath: string
    isRetry: boolean
  }) => { commands: string[]; resetsPage: boolean }
}
```

Add `voiceExpected: boolean` to the `recordSceneWithRetry` options object type, and replace the body of the `for` loop (steps 1 through 5 in the current file) with:

```ts
    const script = scene.script
    if (!script) {
      // Until rehearsal ships (plan 2), a scene without a script cannot be
      // recorded. Fail loudly rather than silently falling back to the
      // deleted recorder agent.
      return {
        status: "failed",
        lastReport: infraFailureReport(
          `scene ${scene.id} has no script — the record pass requires one`
        ),
        attempts: attemptsMade,
      }
    }

    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "recording" })

    // 1. Open the take. A chained scene restarts on the live page; an
    //    independent scene (or any retry) re-opens the start URL.
    const bracket = pure.recordingBracket({
      script,
      videoPath,
      actionsPath,
      isRetry: attempt > 1,
    })
    let bracketFailed = false
    for (const cmd of bracket.commands) {
      const r = await execAgentBrowser([cmd], { timeout: 60_000 })
      if (!r.ok) {
        // A stale recording session is the known failure mode — clear it.
        await execAgentBrowser(["record stop"], { timeout: 15_000 })
        previousFailure = `failed before recording — \`${cmd}\` failed: ${r.error ?? "unknown error"}`
        lastReport = infraFailureReport(previousFailure)
        bracketFailed = true
        break
      }
    }
    if (bracketFailed) {
      log.warn(`[demo-workflow] scene ${scene.id} attempt ${attempt} ${previousFailure}`)
      opts.onProgress?.({
        sceneId: scene.id,
        attempt,
        phase: "failed",
        detail: previousFailure,
      })
      continue
    }

    // 2. Deterministic replay. No LLM on the happy path.
    const outcome = await replayScene({
      script,
      signal,
      onStep: (step) =>
        opts.onProgress?.({
          sceneId: scene.id,
          attempt,
          phase: "recording",
          detail: `step ${step.index + 1}/${script.actions.length}: ${step.cmd}`,
        }),
    })

    // 3. Recording ALWAYS stops before anything else happens.
    const stop = await execAgentBrowser(["record stop"], { timeout: 30_000 })
    if (!stop.ok) {
      log.warn(
        `[demo-workflow] scene ${scene.id} attempt ${attempt} record stop failed: ${stop.error}`
      )
    }

    await writeAgentTranscript(transcriptPath, {
      sceneId: scene.id,
      attempt,
      modelId,
      previousFailure: previousFailure || null,
      replay: outcome,
    })

    if (outcome.status === "aborted") break

    // 4. Deviation: recover with the camera off, then retake.
    if (outcome.status === "deviation" && outcome.deviation) {
      opts.onProgress?.({
        sceneId: scene.id,
        attempt,
        phase: "verifying",
        detail: `recovering: ${outcome.deviation.detail}`,
      })
      const recovery = await recoverFromDeviation({
        workspace,
        modelId,
        script,
        deviation: outcome.deviation,
        signal,
      })
      previousFailure =
        `deviated at step ${outcome.deviation.index} (${outcome.deviation.cmd}): ` +
        `${outcome.deviation.detail}. Recovery ${recovery.recovered ? "cleared it" : "failed"}: ${recovery.detail}`
      lastReport = infraFailureReport(previousFailure)
      log.warn(`[demo-workflow] scene ${scene.id} attempt ${attempt} ${previousFailure}`)
      opts.onProgress?.({
        sceneId: scene.id,
        attempt,
        phase: "failed",
        detail: previousFailure,
      })
      continue
    }

    // 5. Verify the artifact.
    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "verifying" })
    lastReport = await verifyScene({
      script,
      videoPath,
      voiceExpected: opts.voiceExpected,
    })

    if (lastReport.ok) {
      const duration = lastReport.checks.find((c) => c.name === "duration-range")
      opts.onProgress?.({ sceneId: scene.id, attempt, phase: "done" })
      return {
        status: "done",
        result: {
          sceneId: scene.id,
          videoPath,
          actionsPath,
          durationSec: Number(duration?.detail.match(/duration ([\d.]+)s/)?.[1] ?? 0),
          endUrl: script.endUrl,
          attempts: attempt,
          verify: lastReport,
        },
      }
    }

    previousFailure =
      "failed verification — " +
      lastReport.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name}: ${c.detail}`)
        .join("; ")
    log.warn(`[demo-workflow] scene ${scene.id} attempt ${attempt} ${previousFailure}`)
    opts.onProgress?.({
      sceneId: scene.id,
      attempt,
      phase: "failed",
      detail: previousFailure,
    })
```

- [ ] **Step 2: Pass voiceExpected from the workflow**

In `electron/agent/workflows/demo-video.ts`, inside `sceneStep`'s `execute`, change the `recordSceneWithRetry` call to add one option:

```ts
    const outcome = await recordSceneWithRetry({
      scene: sceneToRecord,
      workspace: init.workspace,
      modelId: init.modelId,
      voiceExpected: init.voiceId !== null,
      signal: abortSignal,
      onProgress: (u) => {
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: **no errors.** If `Scene` is now unused in `record-scene.ts`, remove it from the type import.

- [ ] **Step 4: Run the full test suite**

Run: `bun run test:workflows && bun run lint`
Expected: all tests pass, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/record-scene.ts electron/agent/workflows/demo-video.ts
git commit -m "feat: replay replaces the recorder agent in the scene step"
```

---

### Task 9: End-to-end proof with a hand-written script

**Files:**
- Create: `docs/superpowers/fixtures/example-script.json`
- Modify: `docs/superpowers/plans/manual-e2e-checklist.md` (add section E)

This is the task that validates the whole plan. **Nothing here is automated** — there is no browser in CI, and the point is to prove the format against a real site before an agent starts generating it.

- [ ] **Step 1: Write a hand-authored script fixture**

Create `docs/superpowers/fixtures/example-script.json` — two chained scenes against a public site with no login:

```json
{
  "demoTitle": "Wikipedia search",
  "targetUrl": "https://en.wikipedia.org",
  "scenes": [
    {
      "id": "scene-01",
      "title": "Search for a topic",
      "goal": "Show search working from the main page",
      "startUrl": "https://en.wikipedia.org/wiki/Main_Page",
      "endUrl": "https://en.wikipedia.org/wiki/Main_Page",
      "actions": ["type a query into search"],
      "expectedOutcome": "search suggestions visible",
      "narrationHint": "neutral, informative",
      "script": {
        "sceneId": "scene-01",
        "continuity": "independent",
        "oneShot": false,
        "startUrl": "https://en.wikipedia.org/wiki/Main_Page",
        "endUrl": "https://en.wikipedia.org/wiki/Main_Page",
        "actions": [
          {
            "cmd": "find role searchbox fill \"Electron framework\"",
            "assert": "--text \"Electron\"",
            "settleMs": 1200
          }
        ]
      }
    },
    {
      "id": "scene-02",
      "title": "Open the article",
      "goal": "Land on the article page",
      "startUrl": "https://en.wikipedia.org/wiki/Main_Page",
      "endUrl": "https://en.wikipedia.org/wiki/Electron_(software_framework)",
      "actions": ["submit the search"],
      "expectedOutcome": "article page visible",
      "narrationHint": "neutral, informative",
      "script": {
        "sceneId": "scene-02",
        "continuity": "chained",
        "oneShot": false,
        "startUrl": "https://en.wikipedia.org/wiki/Main_Page",
        "endUrl": "https://en.wikipedia.org/wiki/Electron_(software_framework)",
        "actions": [
          {
            "cmd": "press Enter",
            "assert": "--url 'https://en.wikipedia.org/wiki/'",
            "settleMs": 2000
          }
        ]
      }
    }
  ]
}
```

- [ ] **Step 2: Add the walkthrough to the manual checklist**

Append a new lettered section to `docs/superpowers/plans/manual-e2e-checklist.md`,
continuing that file's running item numbering. This has landed as **section E,
items 25–31** in that file — consult the checklist itself for the walkthrough as
executed. The checklist is the single source of truth for these steps; do not
duplicate them here, as copies can drift from the master when fixes are needed
(as they were after the initial draft). Any future updates to the walkthrough
belong in the checklist, not in this plan document.

- [ ] **Step 3: Run the checklist**

Work through **items 25–31 (section E)** of `docs/superpowers/plans/manual-e2e-checklist.md` against a real browser. Record any deviation from the expected behaviour as a GitHub issue rather than patching inline — the plan's assumptions are what is being tested.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/fixtures/example-script.json docs/superpowers/plans/manual-e2e-checklist.md
git commit -m "docs: manual e2e walkthrough for deterministic replay"
```

---

## Known-incomplete after this plan

These are **expected** states, not bugs, and are addressed by plans 2 and 3:

- **No scene can be recorded without a hand-written `script`.** `recordSceneWithRetry` fails loudly for a scene with no script. Rehearsal (plan 2) is what populates it.
- **`audio-track` fails on every scene** when a voice is configured, because TTS still runs *after* recording. Plan 3 moves it ahead.
- **`narrationAnchor` is carried but unused.** Plan 3 consumes it.
- **`oneShot` is carried but unenforced.** Plan 2's Gate B consumes it.
- **`settleMs` is a static number.** Plan 3 derives a floor for it from TTS durations.
- **No post-compose sanity check** on `demo.mp4` (total duration ≈ sum of scene durations, expected scene count). Add it with plan 3's pacing work, when expected total duration becomes meaningful. Use `probeDurationSec`, not a new ffprobe dependency.
- **Scene stitching (spec §4, Option A) is deferred.** Trigger to build it: when a scene routinely needs more than ~10 steps.
