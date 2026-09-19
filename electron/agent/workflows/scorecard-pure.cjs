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
  return {
    kind: "rehearsal",
    flowId,
    status,
    reply: replyKind(text),
    steps: { used, max: maxSteps, exhausted: used >= maxSteps },
    shell: shellStats(steps, workspace),
    toolErrors: toolErrors(steps),
    script: scriptStats(scripts),
    dress: dress || { ran: false },
    detail: String(detail || "").slice(0, 300),
  }
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
  return {
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
  }
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
  return {
    kind: "scene",
    sceneId,
    status,
    attempts,
    firstTake: status === "done" && attempts === 1,
    failedChecks: list.filter((c) => c && c.ok === false).map((c) => c.name),
    durationSec: typeof durationSec === "number" ? durationSec : undefined,
    expectedSec:
      typeof expectedSec === "number" ? +expectedSec.toFixed(2) : undefined,
  }
}

/** One screen of text from a scorecard's entries — what a person reads. */
function summarize(entries) {
  const list = Array.isArray(entries) ? entries : []
  const lines = []
  const flag = (bad) => (bad ? "✗" : "✓")
  for (const e of list) {
    if (e.kind === "rehearsal") {
      const bad =
        e.status !== "done" ||
        e.steps.exhausted ||
        e.shell.onTaskShare < 0.9 ||
        e.shell.forbidden > 0 ||
        e.reply === "empty"
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
      const bad =
        !e.recovered ||
        e.ranScriptedCommand > 0 ||
        e.shell.forbidden > 0 ||
        e.steps.exhausted
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
      lines.push(
        `${flag(false)} run: ${e.scenes} scene(s) composed → ${e.videoPath}`
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
  summarize,
}
