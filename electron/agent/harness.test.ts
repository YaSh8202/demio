// ── The always-a-video ladder, proven offline (ADR-013) ──────────────────────
//
//   bun run test:harness
//
// Runs the real `demo-video` workflow — real replay engine, real verify, real
// EDL, real ffmpeg — against the fake agent-browser playing the camera
// (fixtures/fake-agent-browser.cjs, FAKE_AB_RECORD), and forces each stage to
// fail through `DEMIO_FAULT`. One test per rung, each asserting the same
// three things: a playable demo.mp4 exists, `degraded` is EXACTLY what was
// forced (a rung that fires when it should not is as much a bug as one that
// does not fire), and the run ended.
//
// No network and no API keys: nothing here reaches a model. The narrator only
// runs with a voice configured, and no scene deviates, so recovery never
// starts.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), "demio-harness-"))

// Before the workflow modules load — same reason as recovery.eval.ts:
// `resolveBinaryPath` caches per process and `mastraStore` opens at import.
process.env.DEMIO_HOME = home
process.env.DEMIO_AGENT_BROWSER_BIN = path.join(
  HERE,
  "workflows/fixtures/fake-agent-browser.cjs"
)
process.env.FAKE_AB_RECORD = path.join(home, "take.json")
delete process.env.FAKE_AB_SCENARIO
delete process.env.ELEVENLABS_API_KEY

type Workflow = typeof import("./workflows/demo-video")
let wf: Workflow
let readScorecard: (workspace: string) => Array<Record<string, unknown>>
let probe: (file: string) => Promise<{ durationSec: number; hasAudio: boolean }>

beforeAll(async () => {
  wf = await import("./workflows/demo-video")
  const { probeArtifact } = await import("./workflows/artifact")
  probe = probeArtifact
  readScorecard = (workspace) =>
    fs
      .readFileSync(path.join(workspace, "scorecard.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
})

afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
beforeEach(() => {
  delete process.env.DEMIO_FAULT
})

function scene(
  id: string,
  continuity: "independent" | "chained" = "independent"
) {
  return {
    id,
    title: id,
    goal: `show ${id}`,
    startUrl: "https://example.test/",
    endUrl: "https://example.test/",
    actions: ["scroll"],
    expectedOutcome: "scrolled",
    narrationHint: "",
    script: {
      sceneId: id,
      continuity,
      oneShot: false,
      startUrl: "https://example.test/",
      endUrl: "https://example.test/",
      params: {},
      actions: [
        { cmd: "scroll down 300", settleMs: 700 },
        { cmd: "scroll down 300", settleMs: 700 },
      ],
    },
  }
}

let n = 0
async function run(scenes: ReturnType<typeof scene>[], fault?: string) {
  if (fault) process.env.DEMIO_FAULT = fault
  const workspace = path.join(home, "workspaces", `t${++n}`)
  fs.mkdirSync(workspace, { recursive: true })
  const r = await wf.demoVideoWorkflow.createRun()
  const result = await r.start({
    inputData: {
      plan: { demoTitle: "t", targetUrl: "https://example.test/", scenes },
      workspace,
      modelId: "mock:unused",
      voiceId: null,
      nudges: 0,
      salvaged: false,
    },
  })
  return { result, workspace, runLine: readScorecard(workspace).at(-1)! }
}

/** The three things every rung must leave behind. */
async function expectVideo(
  r: Awaited<ReturnType<typeof run>>,
  degradedStages: string[],
  scenes: number
) {
  expect(r.result.status).toBe("success")
  if (r.result.status !== "success") return
  const video = r.result.result.videoPath
  const { durationSec, hasAudio } = await probe(video)
  expect(durationSec).toBeGreaterThan(1)
  expect(hasAudio).toBe(true) // the uniform silent track — every part has one
  expect(r.result.result.degraded.map((d) => d.stage).sort()).toEqual(
    [...degradedStages].sort()
  )
  expect(r.result.result.scenes).toHaveLength(scenes)
  // …and the same story on the scorecard, where `smoke report` reads it.
  expect(r.runLine["kind"]).toBe("run")
  expect(r.runLine["outcome"]).toBe("video")
  expect(r.runLine["pass"]).toBe(degradedStages.length === 0)
  expect((r.runLine["finalCheck"] as { ok: boolean }).ok).toBe(true)
}

describe("demo-video always ends with a video", () => {
  test("baseline: two scenes, nothing forced, nothing degraded", async () => {
    await expectVideo(await run([scene("a.01"), scene("a.02")]), [], 2)
  }, 60_000)

  test("sync fails → the raw take is used, per scene", async () => {
    const r = await run([scene("a.01"), scene("a.02")], "sync:throw")
    await expectVideo(r, ["sync", "sync"], 2)
  }, 60_000)

  test("compose stream-copy fails → re-encoded", async () => {
    await expectVideo(
      await run([scene("a.01")], "compose:throw"),
      ["compose"],
      1
    )
  }, 60_000)

  test("one scene fails its takes → dropped, the rest ship", async () => {
    const r = await run([scene("a.01"), scene("a.02")], "scene:a.02:fail")
    await expectVideo(r, ["record-scene"], 1)
  }, 60_000)

  test("a chained scene after a dropped one is dropped without a take", async () => {
    const r = await run(
      [scene("a.01"), scene("a.02"), scene("a.03", "chained"), scene("b.01")],
      "scene:a.02:fail"
    )
    await expectVideo(r, ["record-scene", "record-scene"], 2)
    if (r.result.status !== "success") return
    const cascade = r.result.result.degraded.find((d) => d.sceneId === "a.03")
    expect(cascade?.reason).toContain("continues from a.02")
    // No take was spent on it: no scene line on the scorecard.
    expect(
      readScorecard(r.workspace).some(
        (e) => e["kind"] === "scene" && e["sceneId"] === "a.03"
      )
    ).toBe(false)
  }, 60_000)

  test("every scene fails → the floor video, labelled as one", async () => {
    const r = await run([scene("a.01"), scene("a.02")], "scene:*:fail")
    await expectVideo(r, ["record-scene", "record-scene", "floor"], 1)
    if (r.result.status !== "success") return
    expect(r.result.result.scenes[0].sceneId).toBe(wf.FLOOR_SCENE_ID)
  }, 60_000)

  test("a stage that hangs is aborted by its budget, and degrades like any failure", async () => {
    process.env.DEMIO_BUDGET_SYNCPERSCENE_MS = "700"
    try {
      const started = Date.now()
      const r = await run([scene("a.01")], "sync:hang")
      await expectVideo(r, ["sync"], 1)
      expect(Date.now() - started).toBeLessThan(30_000)
      if (r.result.status !== "success") return
      expect(r.result.result.degraded[0].reason).toContain(
        "aborted by its budget"
      )
    } finally {
      delete process.env.DEMIO_BUDGET_SYNCPERSCENE_MS
    }
  }, 60_000)

  test("several rungs at once still end with a video", async () => {
    const r = await run(
      [scene("a.01"), scene("a.02")],
      "scene:a.01:fail,sync:throw,compose:throw"
    )
    await expectVideo(r, ["record-scene", "sync", "compose"], 1)
  }, 60_000)

  test("the floor itself failing is the one true failure — and it says so", async () => {
    const r = await run([scene("a.01")], "scene:*:fail,scene:floor.01:fail")
    expect(r.result.status).toBe("failed")
    if (r.result.status !== "failed") return
    expect(r.result.error.message).toContain("fallback tour")
  }, 60_000)
})
