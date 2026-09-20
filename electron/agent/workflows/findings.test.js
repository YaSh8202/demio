const test = require("node:test")
const assert = require("node:assert")
const { CODES, diagnose, exitCode } = require("./findings-pure.cjs")
const { scoreRun, scoreScene, scoreRehearsal } = require("./scorecard-pure.cjs")

const paths = {
  workspace: "/w",
  scorecard: "/w/scorecard.jsonl",
  events: "/r/events.jsonl",
}
const codes = (findings) => findings.map((f) => f.code)
const done = (over = {}) => ({
  phase: "done",
  video: "/w/output/demo.mp4",
  errors: [],
  gateLog: [],
  ...over,
})
const videoRun = (over = {}) =>
  scoreRun({
    outcome: "video",
    scenes: 2,
    videoPath: "/w/output/demo.mp4",
    finalCheck: { ok: true, durationSec: 12, checks: [] },
    ...over,
  })

test("a clean run has no findings and exits 0", () => {
  const entries = [
    scoreScene({ sceneId: "a.01", status: "done", attempts: 1, checks: [] }),
    videoRun(),
  ]
  const findings = diagnose({ entries, run: done(), paths })
  assert.deepStrictEqual(findings, [])
  assert.strictEqual(exitCode(findings), 0)
})

test("a stalled turn is STALLED + NO_VIDEO and exits 2", () => {
  const findings = diagnose({
    entries: [],
    run: { phase: "stalled", detail: "turn ended", errors: [], gateLog: [] },
    paths,
  })
  assert.deepStrictEqual(codes(findings).sort(), ["NO_VIDEO", "STALLED"])
  assert.strictEqual(exitCode(findings), 2)
})

test("a run still in flight is not called NO_VIDEO", () => {
  const findings = diagnose({
    entries: [],
    run: { phase: "running", errors: [], gateLog: [] },
    paths,
  })
  assert.deepStrictEqual(findings, [])
})

test("the wall-clock kill is BUDGET_EXCEEDED", () => {
  const findings = diagnose({
    entries: [],
    run: {
      phase: "timeout",
      detail: "exceeded 1800s while running rehearse_flow",
      errors: [],
      gateLog: [],
    },
    paths,
  })
  assert.ok(codes(findings).includes("BUDGET_EXCEEDED"))
  assert.match(
    findings.find((f) => f.code === "BUDGET_EXCEEDED").cause,
    /rehearse_flow/
  )
})

test("a failed run line is HARNESS_THREW with the error as the cause", () => {
  const entries = [
    scoreRun({
      outcome: "failed",
      scenes: 0,
      error: "demo-video workflow failed: compose: no retimed output for a.01",
    }),
  ]
  const findings = diagnose({
    entries,
    run: { phase: "error", errors: [], gateLog: [] },
    paths,
  })
  assert.deepStrictEqual(codes(findings).sort(), ["HARNESS_THREW", "NO_VIDEO"])
  assert.match(findings[0].cause, /no retimed output/)
})

test("each degradation maps to its own code and the run still has a video", () => {
  const entries = [
    videoRun({
      degraded: [
        { stage: "sync", sceneId: "a.01", reason: "ffmpeg exited 1" },
        { stage: "tts", reason: "elevenlabs 401" },
        { stage: "record-scene", sceneId: "a.02", reason: "3 takes failed" },
      ],
    }),
  ]
  const findings = diagnose({ entries, run: done(), paths })
  assert.deepStrictEqual(codes(findings).sort(), [
    "DEGRADED_SYNC",
    "DEGRADED_TTS",
    "SCENE_DROPPED",
  ])
  assert.strictEqual(exitCode(findings), 1)
  const sync = findings.find((f) => f.code === "DEGRADED_SYNC")
  assert.ok(
    sync.evidence.some((e) => e.path === "/w/scenes/a.01.attempt-1.agent.json")
  )
  assert.strictEqual(sync.source, "electron/agent/workflows/sync.ts")
})

test("the floor video is critical even though a video exists", () => {
  const entries = [
    videoRun({
      scenes: 1,
      degraded: [{ stage: "floor", reason: "no scene survived" }],
    }),
  ]
  const findings = diagnose({ entries, run: done(), paths })
  assert.strictEqual(findings[0].code, "FLOOR_VIDEO")
  assert.strictEqual(findings[0].severity, "critical")
  assert.strictEqual(exitCode(findings), 1)
})

test("failed final-video checks become VIDEO_* findings", () => {
  const entries = [
    videoRun({
      finalCheck: {
        ok: false,
        durationSec: 1,
        checks: [
          {
            name: "duration-range",
            ok: false,
            detail: "duration 1.0s, scenes total 20.0s",
          },
          { name: "audio-track", ok: false, detail: "no audio track" },
          { name: "black-frames", ok: true, detail: "none" },
        ],
      },
    }),
  ]
  assert.deepStrictEqual(
    codes(diagnose({ entries, run: done(), paths })).sort(),
    ["VIDEO_SILENT", "VIDEO_TOO_SHORT"]
  )
})

test("scenario expectations: scenes, degradations and the duration the prompt asked for", () => {
  const entries = [
    videoRun({
      scenes: 1,
      finalCheck: { ok: true, durationSec: 5.7, checks: [] },
    }),
  ]
  const findings = diagnose({
    entries,
    run: done(),
    scenario: { expect: { minScenes: 2, minDurationSec: 8 } },
    paths,
  })
  assert.deepStrictEqual(codes(findings), ["EXPECT_UNMET"])
  assert.match(findings[0].cause, /1 scene\(s\), expected at least 2/)
  assert.match(findings[0].cause, /5\.7s/)
})

test("a retried scene is info only — it does not fail the run", () => {
  const entries = [
    scoreScene({ sceneId: "a.01", status: "done", attempts: 2, checks: [] }),
    videoRun(),
  ]
  const findings = diagnose({ entries, run: done(), paths })
  assert.deepStrictEqual(codes(findings), ["SCENE_RETRIED"])
  assert.strictEqual(exitCode(findings), 0)
})

test("rehearsal lines: blocked, exhausted, lint rules", () => {
  const steps = Array.from({ length: 3 }, () => ({
    toolCalls: [],
    toolResults: [
      {
        isError: true,
        result: "script a.01 was rejected:\n[element-ref @2] uses @e12",
      },
    ],
  }))
  const entries = [
    scoreRehearsal({
      flowId: "a",
      status: "blocked",
      detail: "login wall",
      text: "BLOCKED",
      steps,
      maxSteps: 3,
      scripts: [],
      dress: { ran: false },
      workspace: "/w",
    }),
    videoRun(),
  ]
  const found = codes(diagnose({ entries, run: done(), paths }))
  for (const code of [
    "REHEARSAL_BLOCKED",
    "REHEARSAL_EXHAUSTED",
    "LINT_REJECTED",
  ])
    assert.ok(found.includes(code), code)
})

test("more than three ask_user gates is GATE_SPAM; submit_plan does not count", () => {
  const gateLog = [
    ...Array.from({ length: 4 }, (_, i) => ({
      tool: "ask_user",
      question: `q${i}`,
    })),
    { tool: "submit_plan" },
  ]
  assert.ok(
    codes(
      diagnose({ entries: [videoRun()], run: done({ gateLog }), paths })
    ).includes("GATE_SPAM")
  )
  assert.ok(
    !codes(
      diagnose({
        entries: [videoRun()],
        run: done({ gateLog: gateLog.slice(1) }),
        paths,
      })
    ).includes("GATE_SPAM")
  )
})

test("a run made in the app (no smoke state) is diagnosed from the scorecard alone", () => {
  assert.deepStrictEqual(diagnose({ entries: [videoRun()], paths }), [])
  assert.deepStrictEqual(codes(diagnose({ entries: [], paths })), ["NO_VIDEO"])
})

test("every emitted code is in the closed list", () => {
  const entries = [
    videoRun({
      nudges: 1,
      salvaged: true,
      degraded: [
        { stage: "compose", reason: "x" },
        { stage: "narrate", reason: "y" },
      ],
    }),
  ]
  for (const f of diagnose({ entries, run: done(), paths }))
    assert.ok(CODES[f.code], f.code)
})
