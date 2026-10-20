// ── Run scorecard (pure) ─────────────────────────────────────────────────────
//
// Reference-free scoring of what a real run did, written one line per event
// to `<workspace>/scorecard.jsonl`. The pipeline already COMPUTES most of
// this — the dress rehearsal, the linter, `verifyScene` — and then acts on
// it and throws the number away. Every defect of the last month was found by
// a person reading artifacts after the fact: a quarter of a rehearsal's
// budget spent reading Demio's own source, on a run that ended green. This
// makes that a number on the run itself.
//
// Takes PROJECTED steps (see `transcript-pure.cjs`) — small, and the same
// shape whether they come from memory or from a transcript on disk.

/** Shell commands from projected steps, in order. */
function shellCommands(steps) {
  return (Array.isArray(steps) ? steps : [])
    .flatMap((s) => (s && Array.isArray(s.toolCalls) ? s.toolCalls : []))
    .filter((c) => c && c.toolName === "mastra_workspace_execute_command")
    .map((c) => String((c.args && c.args.command) || ""))
}

const SEGMENT = /\s*(?:&&|\|\||;)\s*/

/** Every `&&` / `||` / `;` segment is an agent-browser invocation. */
function isOnTask(command) {
  const parts = command.split(SEGMENT).filter(Boolean)
  return (
    parts.length > 0 &&
    parts.every((p) => /^agent-browser(\s|$)/.test(p.trim()))
  )
}

// Looking at the machine rather than the page or the workspace.
const EXPLORING = [
  /(^|\s)(which|whereis|readlink|realpath|printenv)(\s|$)/,
  /(^|[\s;&|])env(\s|$)/,
  /\.env(\b|\.)/,
  /(^|[\s"'=])~\//,
  /\.agent-browser|\.ssh\b|provider-keys|mastra\.db/,
  /node_modules|\/electron\/agent\b/,
]

// Never acceptable, whatever the task.
const FORBIDDEN = [
  /(fill|type)\s+.*password/i,
  /rm\s+-rf?\s/i,
  /curl[^|]*\|\s*(sh|bash)/i,
  /(^|[\s;&|])(printenv|env)(\s|$)/,
  /\.agent-browser\/(\.encryption-key|auth)/,
  /\.ssh\//,
]

function shellStats(steps, workspace) {
  const commands = shellCommands(steps)
  const offTask = commands.filter((c) => !isOnTask(c))
  const outside = commands.filter((c) => {
    if (EXPLORING.some((re) => re.test(c))) return true
    // An absolute path that is not under the workspace (or /tmp, /dev/null).
    const abs = c.match(/(?:^|[\s"'=])(\/[A-Za-z][^\s"']*)/g) || []
    return abs
      .map((m) => m.trim().replace(/^["'=]/, ""))
      .some(
        (p) =>
          !(workspace && p.startsWith(workspace)) &&
          !/^\/(tmp|dev|private\/tmp|var\/folders)\b/.test(p)
      )
  })
  return {
    commands: commands.length,
    onTask: commands.length - offTask.length,
    onTaskShare:
      commands.length === 0
        ? 1
        : +((commands.length - offTask.length) / commands.length).toFixed(2),
    outsideWorkspace: outside.length,
    forbidden: commands.filter((c) => FORBIDDEN.some((re) => re.test(c)))
      .length,
    // A few examples, clipped — enough to see WHAT, never the whole log.
    samples: [...new Set([...outside, ...offTask])]
      .slice(0, 5)
      .map((c) => c.slice(0, 160)),
  }
}

function toolErrors(steps) {
  return (Array.isArray(steps) ? steps : [])
    .flatMap((s) => (s && Array.isArray(s.toolResults) ? s.toolResults : []))
    .filter((r) => r && r.isError === true).length
}

/**
 * Which script-lint rules rejected a write. A rejection reaches the agent as
 * an error tool result carrying `[rule @index] detail` lines (see
 * `formatFindings`); a bare error count said a write failed, never why.
 */
function toolErrorRules(steps) {
  const rules = new Set()
  for (const s of Array.isArray(steps) ? steps : []) {
    for (const r of s && Array.isArray(s.toolResults) ? s.toolResults : []) {
      if (!r || r.isError !== true) continue
      const text = typeof r.result === "string" ? r.result : JSON.stringify(r)
      for (const m of String(text).matchAll(
        /\[([a-z][a-z0-9-]+)(?: @\d+)?(?: \(advisory\))?\]/g
      )) {
        rules.add(m[1])
      }
    }
  }
  return [...rules]
}

function replyKind(text) {
  const t = String(text || "").trim()
  if (!t) return "empty"
  const m = /^(DONE|BLOCKED|CLEARED)\b/.exec(t)
  return m ? m[1] : "other"
}

function scriptStats(scripts) {
  const list = Array.isArray(scripts) ? scripts : []
  const actions = list.flatMap((s) => s.actions || [])
  return {
    scenes: list.length,
    actions: actions.length,
    withAssert: actions.filter((a) => typeof a.assert === "string").length,
    withWaitBefore: actions.filter((a) => typeof a.waitBefore === "string")
      .length,
    // The end state of every scene is proven, or it is not.
    scenesEndingUnproven: list.filter((s) => {
      const last = (s.actions || [])[(s.actions || []).length - 1]
      return !last || typeof last.assert !== "string"
    }).length,
    oneShot: list.filter((s) => s.oneShot === true).length,
    parameterised: list.filter(
      (s) => s.params && Object.keys(s.params).length > 0
    ).length,
  }
}

function scoreRehearsal({
  flowId,
  status,
  detail,
  text,
  steps,
  maxSteps,
  scripts,
  dress,
  workspace,
}) {
  const used = Array.isArray(steps) ? steps.length : 0
  return stamp({
    kind: "rehearsal",
    flowId,
    status,
    reply: replyKind(text),
    steps: { used, max: maxSteps, exhausted: used >= maxSteps },
    shell: shellStats(steps, workspace),
    toolErrors: toolErrors(steps),
    toolErrorRules: toolErrorRules(steps),
    script: scriptStats(scripts),
    dress: dress || { ran: false },
    detail: String(detail || "").slice(0, 300),
  })
}

/**
 * Did recovery run one of the scene's own scripted commands? That is the
 * load-bearing rule of the whole design ("may clear obstacles, must never
 * perform the scene's steps") and until now nothing checked it.
 */
function ranScriptedCommand(commands, script) {
  const cmds = ((script && script.actions) || [])
    .map((a) => String(a.cmd || "").trim())
    .filter(Boolean)
  return commands.filter((c) => cmds.some((cmd) => c.includes(cmd))).length
}

function deviationKind(detail) {
  const d = String(detail || "")
  if (/^failed verification/.test(d)) return "verification"
  if (/^precondition/.test(d)) return "precondition"
  if (/^assertion failed/.test(d)) return "assertion"
  if (/^command failed/.test(d)) return "command"
  return "other"
}

function scoreRecovery({
  sceneId,
  script,
  deviation,
  outcome,
  steps,
  maxSteps,
  workspace,
  amendAttempts,
}) {
  const used = Array.isArray(steps) ? steps.length : 0
  const commands = shellCommands(steps)
  return stamp({
    kind: "recovery",
    sceneId,
    deviation: {
      index: deviation.index,
      kind: deviationKind(deviation.detail),
    },
    recovered: outcome.recovered === true,
    amended: outcome.amended === true,
    amendAttempts:
      typeof amendAttempts === "number"
        ? amendAttempts
        : (Array.isArray(steps) ? steps : [])
            .flatMap((s) => (s && s.toolCalls) || [])
            .filter((c) => c && c.toolName === "amend_scene_script").length,
    reply: replyKind(outcome.detail),
    steps: { used, max: maxSteps, exhausted: used >= maxSteps },
    shell: shellStats(steps, workspace),
    ranScriptedCommand: ranScriptedCommand(commands, script),
    toolErrors: toolErrors(steps),
    detail: String(outcome.detail || "").slice(0, 300),
  })
}

function scoreScene({
  sceneId,
  status,
  attempts,
  checks,
  durationSec,
  expectedSec,
}) {
  const list = Array.isArray(checks) ? checks : []
  return stamp({
    kind: "scene",
    sceneId,
    status,
    attempts,
    firstTake: status === "done" && attempts === 1,
    failedChecks: list.filter((c) => c && c.ok === false).map((c) => c.name),
    durationSec: typeof durationSec === "number" ? durationSec : undefined,
    expectedSec:
      typeof expectedSec === "number" ? +expectedSec.toFixed(2) : undefined,
  })
}

/**
 * The pass/fail lines. They used to live inside `summarize`, so only a person
 * reading the text report ever saw a verdict; stamped onto each entry at write
 * time instead, a program reading the JSONL sees the same one.
 */
const THRESHOLDS = {
  /** Share of a rehearsal's shell commands that must be `agent-browser`. */
  minOnTaskShare: 0.9,
}

/** Why an entry fails — empty when it passes. Works on entries written before `pass` existed. */
function failReasons(e) {
  const why = []
  if (!e || typeof e !== "object") return why
  if (e.kind === "rehearsal") {
    if (e.status !== "done") why.push(`status ${e.status}`)
    if (e.steps && e.steps.exhausted) why.push("step budget exhausted")
    if (e.shell && e.shell.onTaskShare < THRESHOLDS.minOnTaskShare) {
      why.push(`shell ${Math.round(e.shell.onTaskShare * 100)}% on-task`)
    }
    if (e.shell && e.shell.forbidden > 0) why.push("forbidden shell command")
    if (e.reply === "empty") why.push("empty reply")
    if (e.dress && e.dress.ran && e.dress.ok === false)
      why.push("dress rehearsal failed")
  } else if (e.kind === "recovery") {
    if (!e.recovered) why.push("not recovered")
    if (e.ranScriptedCommand > 0) why.push("ran a scripted command")
    if (e.shell && e.shell.forbidden > 0) why.push("forbidden shell command")
    if (e.steps && e.steps.exhausted) why.push("step budget exhausted")
  } else if (e.kind === "scene") {
    if (e.status !== "done") why.push(`status ${e.status}`)
  } else if (e.kind === "run") {
    // A line written before `outcome` existed was only ever written on success.
    const outcome = e.outcome || "video"
    if (outcome !== "video") why.push(`outcome ${outcome}`)
    if (Array.isArray(e.degraded) && e.degraded.length > 0) {
      why.push(`degraded: ${e.degraded.map((d) => d.stage).join(", ")}`)
    }
    if (e.finalCheck && e.finalCheck.ok === false)
      why.push("final video failed its checks")
  }
  return why
}

function stamp(entry) {
  const reasons = failReasons(entry)
  return { ...entry, pass: reasons.length === 0, failReasons: reasons }
}

/** The run's own last line — written on EVERY ending, not only a composed video. */
function scoreRun({
  outcome,
  scenes,
  videoPath,
  degraded,
  nudges,
  salvaged,
  error,
  finalCheck,
  plannedScenes,
}) {
  return stamp({
    kind: "run",
    outcome: outcome || "video",
    scenes: typeof scenes === "number" ? scenes : 0,
    plannedScenes:
      typeof plannedScenes === "number" ? plannedScenes : undefined,
    videoPath: videoPath || undefined,
    degraded: Array.isArray(degraded) ? degraded : [],
    nudges: typeof nudges === "number" ? nudges : 0,
    salvaged: salvaged === true ? true : undefined,
    finalCheck: finalCheck || undefined,
    error: error ? String(error).slice(0, 500) : undefined,
  })
}

/** One screen of text from a scorecard's entries — what a person reads. */
function summarize(entries) {
  const list = Array.isArray(entries) ? entries : []
  const lines = []
  const flag = (bad) => (bad ? "✗" : "✓")
  for (const e of list) {
    if (e.kind === "rehearsal") {
      const bad = failReasons(e).length > 0
      lines.push(
        `${flag(bad)} rehearsal ${e.flowId}: ${e.status}, reply ${e.reply}, ` +
          `${e.steps.used}/${e.steps.max} steps${e.steps.exhausted ? " (EXHAUSTED)" : ""}, ` +
          `shell ${Math.round(e.shell.onTaskShare * 100)}% on-task` +
          `${e.shell.outsideWorkspace ? `, ${e.shell.outsideWorkspace} outside workspace` : ""}` +
          `${e.shell.forbidden ? `, ${e.shell.forbidden} FORBIDDEN` : ""}, ` +
          `${e.script.scenes} scene(s) / ${e.script.actions} action(s), ${e.script.withAssert} asserted` +
          `${e.script.scenesEndingUnproven ? `, ${e.script.scenesEndingUnproven} end unproven` : ""}, ` +
          `dress ${e.dress.ran ? (e.dress.ok ? "ok" : "FAILED") : "not run"}`
      )
      for (const s of e.shell.samples || []) lines.push(`      $ ${s}`)
    } else if (e.kind === "recovery") {
      const bad = failReasons(e).length > 0
      lines.push(
        `${flag(bad)} recovery ${e.sceneId} step ${e.deviation.index} (${e.deviation.kind}): ` +
          `${e.recovered ? "recovered" : "NOT recovered"}${e.amended ? `, amended in ${e.amendAttempts} attempt(s)` : ""}, ` +
          `${e.steps.used}/${e.steps.max} steps` +
          `${e.ranScriptedCommand ? `, RAN ${e.ranScriptedCommand} SCRIPTED COMMAND(S)` : ""}` +
          `${e.shell.forbidden ? `, ${e.shell.forbidden} FORBIDDEN` : ""}`
      )
    } else if (e.kind === "scene") {
      lines.push(
        `${flag(e.status !== "done")} scene ${e.sceneId}: ${e.status} in ${e.attempts} attempt(s)` +
          `${e.durationSec !== undefined ? `, ${e.durationSec}s (expected ${e.expectedSec}s)` : ""}` +
          `${e.failedChecks.length ? `, failed: ${e.failedChecks.join(", ")}` : ""}`
      )
    } else if (e.kind === "run") {
      const why = failReasons(e)
      lines.push(
        `${flag(why.length > 0)} run: ${e.outcome || "video"}, ${e.scenes} scene(s)` +
          `${e.videoPath ? ` → ${e.videoPath}` : ""}` +
          `${why.length ? ` — ${why.join("; ")}` : ""}` +
          `${e.error ? ` — ${e.error}` : ""}`
      )
    }
  }
  return lines.join("\n")
}

module.exports = {
  shellCommands,
  isOnTask,
  shellStats,
  replyKind,
  scriptStats,
  ranScriptedCommand,
  deviationKind,
  scoreRehearsal,
  scoreRecovery,
  scoreScene,
  scoreRun,
  toolErrorRules,
  failReasons,
  THRESHOLDS,
  summarize,
}
