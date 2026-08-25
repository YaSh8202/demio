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
      settleMs: typeof a.settleMs === "number" ? a.settleMs : DEFAULT_SETTLE_MS,
      narrationAnchor:
        typeof a.narrationAnchor === "number" ? a.narrationAnchor : undefined,
    })),
  }
}

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
