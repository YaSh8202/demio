// ── Run findings (pure, no I/O) ──────────────────────────────────────────────
//
// Turns what a run left behind — its scorecard lines and, for a smoke run, the
// runner's state — into a closed list of findings a coding agent can act on
// without reading a transcript first. Each finding names what went wrong, the
// file that proves it, and the source file that produced the behaviour.
//
// Deterministic on purpose: no model reads the run. The caller of
// `smoke report` is already a model, with the source open — a second one here
// would cost money to guess at what the caller can check. Same pure/binding
// split as the scorecard: plain CommonJS so `node --test` loads it directly.

const { failReasons } = require("./scorecard-pure.cjs")

/** Every code `diagnose` can emit. Closed: a new failure shape gets a new code here, not free text. */
const CODES = {
  NO_VIDEO: "the run ended and there is no output/demo.mp4",
  HARNESS_THREW: "harness code threw — a bug, not a model failure",
  BUDGET_EXCEEDED: "the run hit its wall-clock budget and was killed",
  STALLED: "the agent's turn ended with no video and no open gate",
  STALL_NUDGED: "the harness had to nudge a stalled agent to continue",
  SALVAGED: "the harness built the scene plan itself from rehearsed scripts",
  FLOOR_VIDEO:
    "no scene survived — the video is the deterministic fallback tour",
  REHEARSAL_BLOCKED: "a flow's rehearsal did not finish",
  REHEARSAL_EXHAUSTED: "a rehearsal used its whole step budget",
  RECOVERY_FAILED: "a deviation during recording was not recovered",
  SCENE_DROPPED: "a scene was dropped from the video",
  SCENE_RETRIED: "a scene needed more than one take",
  DEGRADED_NARRATE: "narration failed — the video is silent",
  DEGRADED_TTS: "speech synthesis failed — the video is silent",
  DEGRADED_SYNC: "retiming failed — a scene uses its raw take",
  DEGRADED_COMPOSE:
    "the stream-copy concat failed — the video was re-encoded or is partial",
  GATE_SPAM: "the agent asked the user too many questions",
  SHELL_OFF_TASK: "a sub-agent's shell wandered off agent-browser",
  SHELL_FORBIDDEN: "a sub-agent ran a forbidden shell command",
  LINT_REJECTED: "script writes were rejected by the linter",
  VIDEO_TOO_SHORT: "the final video is shorter than it should be",
  VIDEO_BLACK: "the final video has black frames",
  VIDEO_SILENT: "a voiced run produced a video with no audio track",
  EXPECT_UNMET: "the scenario's own expectation was not met",
}

const MAX_ASK_USER_GATES = 3

const SRC = {
  controller: "electron/agent/controller.ts",
  workflow: "electron/agent/workflows/demo-video.ts",
  rehearse: "electron/agent/workflows/rehearse.ts",
  recovery: "electron/agent/workflows/recovery.ts",
  record: "electron/agent/workflows/record-scene.ts",
  narrate: "electron/agent/workflows/narrate.ts",
  tts: "electron/agent/lib/voiceover.ts",
  sync: "electron/agent/workflows/sync.ts",
  prompts: "electron/agent/prompts.ts",
  lint: "electron/agent/workflows/script-lint-pure.cjs",
  sandbox: "electron/agent/workflows/sandbox-env-pure.cjs",
}

const STAGE_CODE = {
  narrate: ["DEGRADED_NARRATE", SRC.narrate],
  tts: ["DEGRADED_TTS", SRC.tts],
  sync: ["DEGRADED_SYNC", SRC.sync],
  compose: ["DEGRADED_COMPOSE", SRC.workflow],
  "record-scene": ["SCENE_DROPPED", SRC.record],
  floor: ["FLOOR_VIDEO", SRC.workflow],
}

const CHECK_CODE = {
  "duration-range": "VIDEO_TOO_SHORT",
  "black-frames": "VIDEO_BLACK",
  "audio-track": "VIDEO_SILENT",
}

/**
 * @param {object} o
 * @param {object[]} o.entries   scorecard.jsonl lines
 * @param {object} [o.run]       smoke RunState — absent for a run made in the app
 * @param {object} [o.scenario]  smoke Scenario — for `expect`
 * @param {object} [o.paths]     { workspace, scorecard, events, runnerLog }
 */
function diagnose({ entries, run, scenario, paths }) {
  const list = Array.isArray(entries) ? entries : []
  const p = paths || {}
  const findings = []
  const add = (code, severity, cause, source, evidence) =>
    findings.push({
      code,
      severity,
      what: CODES[code],
      cause,
      source,
      evidence: (evidence || []).filter((e) => e && e.path),
    })
  const inWorkspace = (rel) =>
    p.workspace ? `${p.workspace}/${rel}` : undefined
  const scorecardLine = (e) => ({
    path: p.scorecard,
    note: `${e.kind} line at ${e.at}`,
  })

  const runLines = list.filter((e) => e.kind === "run")
  const runLine = runLines[runLines.length - 1]
  const hasVideo = Boolean(
    (runLine && (runLine.outcome || "video") === "video") || (run && run.video)
  )
  const over =
    !run || ["done", "stalled", "error", "timeout"].includes(run.phase)

  // ── How the run ended ────────────────────────────────────────────────────
  if (run && run.phase === "timeout") {
    add("BUDGET_EXCEEDED", "critical", run.detail || "", SRC.controller, [
      { path: p.events, note: "last events before the kill" },
      { path: p.runnerLog },
    ])
  }
  if (runLine && runLine.outcome === "failed") {
    add("HARNESS_THREW", "critical", runLine.error || "", SRC.workflow, [
      scorecardLine(runLine),
      { path: inWorkspace("logs"), note: "ffmpeg stderr, if a render failed" },
    ])
  }
  for (const err of (run && run.errors) || []) {
    if (runLine && runLine.error && err.message.includes(runLine.error))
      continue
    add("HARNESS_THREW", "critical", err.message, SRC.controller, [
      { path: p.events, note: `error event at ${err.at}` },
      { path: p.runnerLog },
    ])
  }
  if (run && run.phase === "stalled") {
    add("STALLED", "critical", run.detail || "", SRC.prompts, [
      {
        path: p.events,
        note: "the final assistant message says why it stopped",
      },
      { path: inWorkspace("rehearsal/checkpoint.json") },
    ])
  }
  if (over && !hasVideo) {
    add(
      "NO_VIDEO",
      "critical",
      runLine
        ? `run line says outcome ${runLine.outcome}`
        : "the demo-video workflow never reached an ending — generate_demo was not called, or threw before recording",
      SRC.controller,
      [{ path: p.scorecard }, { path: p.events }]
    )
  }

  // ── What the harness had to do to get there ──────────────────────────────
  if (runLine) {
    if (runLine.nudges > 0) {
      add("STALL_NUDGED", "warn", `${runLine.nudges} nudge(s)`, SRC.prompts, [
        scorecardLine(runLine),
        { path: p.events },
      ])
    }
    if (runLine.salvaged) {
      add(
        "SALVAGED",
        "warn",
        "the model never produced a usable plan",
        SRC.prompts,
        [scorecardLine(runLine), { path: inWorkspace("plans") }]
      )
    }
    for (const d of runLine.degraded || []) {
      const [code, source] = STAGE_CODE[d.stage] || [
        "HARNESS_THREW",
        SRC.workflow,
      ]
      add(
        code,
        code === "FLOOR_VIDEO" ? "critical" : "warn",
        `${d.sceneId ? `${d.sceneId}: ` : ""}${d.reason}`,
        source,
        [
          scorecardLine(runLine),
          d.sceneId && {
            path: inWorkspace(`scenes/${d.sceneId}.attempt-1.agent.json`),
            note: "the take's replay outcome and recovery transcript",
          },
          { path: inWorkspace(`logs/${d.stage}.stderr.txt`) },
        ]
      )
    }
    for (const c of (runLine.finalCheck && runLine.finalCheck.checks) || []) {
      if (c.ok || !CHECK_CODE[c.name]) continue
      add(CHECK_CODE[c.name], "warn", c.detail, SRC.workflow, [
        { path: runLine.videoPath },
        scorecardLine(runLine),
      ])
    }
  }

  // ── Per-stage scorecard lines ────────────────────────────────────────────
  for (const e of list) {
    if (e.kind === "rehearsal") {
      const transcript = {
        path: inWorkspace(`rehearsal/${e.flowId}.agent.json`),
        note: "the rehearsal sub-agent's steps",
      }
      if (e.status !== "done") {
        add(
          "REHEARSAL_BLOCKED",
          "warn",
          `${e.flowId}: ${e.detail}`,
          SRC.rehearse,
          [transcript, { path: inWorkspace("rehearsal/findings.md") }]
        )
      }
      if (e.steps && e.steps.exhausted) {
        add(
          "REHEARSAL_EXHAUSTED",
          "warn",
          `${e.flowId}: ${e.steps.used}/${e.steps.max} steps`,
          SRC.rehearse,
          [transcript]
        )
      }
      if (e.toolErrorRules && e.toolErrorRules.length > 0) {
        add(
          "LINT_REJECTED",
          "info",
          `${e.flowId}: ${e.toolErrorRules.join(", ")}`,
          SRC.lint,
          [transcript]
        )
      }
    }
    if (e.kind === "rehearsal" || e.kind === "recovery") {
      const who = e.kind === "rehearsal" ? e.flowId : e.sceneId
      if (e.shell && e.shell.forbidden > 0) {
        add(
          "SHELL_FORBIDDEN",
          "critical",
          `${e.kind} ${who}: ${(e.shell.samples || []).join(" | ")}`,
          SRC.sandbox,
          [scorecardLine(e)]
        )
      } else if (failReasons(e).some((r) => r.includes("on-task"))) {
        add(
          "SHELL_OFF_TASK",
          "info",
          `${e.kind} ${who}: ${(e.shell.samples || []).join(" | ")}`,
          SRC.prompts,
          [scorecardLine(e)]
        )
      }
    }
    if (e.kind === "recovery" && !e.recovered) {
      add(
        "RECOVERY_FAILED",
        "warn",
        `${e.sceneId} step ${e.deviation && e.deviation.index} (${e.deviation && e.deviation.kind}): ${e.detail}`,
        SRC.recovery,
        [scorecardLine(e)]
      )
    }
    if (e.kind === "scene" && e.status === "done" && e.attempts > 1) {
      add(
        "SCENE_RETRIED",
        "info",
        `${e.sceneId}: ${e.attempts} attempts`,
        SRC.record,
        [
          {
            path: inWorkspace(`scenes/${e.sceneId}.attempt-1.agent.json`),
            note: "why the first take failed",
          },
        ]
      )
    }
  }

  // ── The conversation ─────────────────────────────────────────────────────
  const asks = ((run && run.gateLog) || []).filter((g) => g.tool === "ask_user")
  if (asks.length > MAX_ASK_USER_GATES) {
    add(
      "GATE_SPAM",
      "warn",
      `${asks.length} questions: ${asks
        .map((g) => g.question)
        .join(" | ")
        .slice(0, 400)}`,
      SRC.prompts,
      [{ path: p.events }]
    )
  }

  // ── The scenario's own bar ───────────────────────────────────────────────
  const expect = (scenario && scenario.expect) || {}
  if (over && hasVideo && runLine) {
    const unmet = []
    if (
      typeof expect.minScenes === "number" &&
      runLine.scenes < expect.minScenes
    ) {
      unmet.push(
        `${runLine.scenes} scene(s), expected at least ${expect.minScenes}`
      )
    }
    const degraded = (runLine.degraded || []).length
    if (
      typeof expect.maxDegraded === "number" &&
      degraded > expect.maxDegraded
    ) {
      unmet.push(
        `${degraded} degradation(s), expected at most ${expect.maxDegraded}`
      )
    }
    const duration = runLine.finalCheck && runLine.finalCheck.durationSec
    if (
      typeof expect.minDurationSec === "number" &&
      typeof duration === "number" &&
      duration < expect.minDurationSec
    ) {
      unmet.push(
        `video is ${duration.toFixed(1)}s, the prompt asked for at least ${expect.minDurationSec}s`
      )
    }
    if (unmet.length > 0) {
      add("EXPECT_UNMET", "warn", unmet.join("; "), SRC.prompts, [
        scorecardLine(runLine),
        { path: inWorkspace("plans") },
      ])
    }
  }

  const rank = { critical: 0, warn: 1, info: 2 }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity])
  return findings
}

/** 0 clean · 1 a video, with findings worth a look · 2 no video. `info` alone is clean. */
function exitCode(findings) {
  if (findings.some((f) => f.code === "NO_VIDEO")) return 2
  return findings.some((f) => f.severity !== "info") ? 1 : 0
}

module.exports = { CODES, diagnose, exitCode, MAX_ASK_USER_GATES }
