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
    params:
      raw.params && typeof raw.params === "object" ? { ...raw.params } : {},
    actions: raw.actions.map((a) => ({
      cmd: String(a.cmd),
      waitBefore: typeof a.waitBefore === "string" ? a.waitBefore : undefined,
      assert: typeof a.assert === "string" ? a.assert : undefined,
      settleMs: typeof a.settleMs === "number" ? a.settleMs : DEFAULT_SETTLE_MS,
      narrationAnchor:
        typeof a.narrationAnchor === "number" ? a.narrationAnchor : undefined,
    })),
  }
}

/**
 * Placeholder syntax: `{{name}}`, bare identifier, no inner spaces. Kept
 * deliberately narrow so a literal `{{` in a command (rare, but legal in a
 * search box) cannot be mistaken for a placeholder unless it names a valid
 * identifier.
 */
const PARAM_RE = /\{\{([A-Za-z0-9_]+)\}\}/g

/**
 * Substitute `{{name}}` placeholders from `script.params` (spec §11).
 *
 * Single-pass: a param VALUE containing `{{...}}` is left alone rather than
 * re-expanded. `String.replace` with a function already gives this — the
 * property is asserted by a test so a later rewrite cannot lose it.
 *
 * Throws on an unresolved placeholder rather than leaving it in the command.
 * A literal `{{boardName}}` typed into a form field is a silent wrong take:
 * every assertion could still pass while the video shows nonsense.
 */
function resolveParams(script) {
  const params = script.params || {}
  const substitute = (value, where) =>
    value.replace(PARAM_RE, (_whole, key) => {
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        throw new Error(
          `script ${script.sceneId}: ${where} references {{${key}}}, ` +
            `but the script defines no param by that name`
        )
      }
      return params[key]
    })
  return {
    ...script,
    actions: script.actions.map((a, i) => ({
      ...a,
      cmd: substitute(a.cmd, `action ${i} cmd`),
      waitBefore:
        a.waitBefore === undefined
          ? undefined
          : substitute(a.waitBefore, `action ${i} waitBefore`),
      assert:
        a.assert === undefined
          ? undefined
          : substitute(a.assert, `action ${i} assert`),
    })),
  }
}

/**
 * Per-action baseline: the wall-clock a command costs beyond its settle
 * time (CDP round trip, cursor animation, typing jitter). Used only to
 * predict a take's length for the duration check — never to pace replay.
 */
const ACTION_BASELINE_MS = 400

/**
 * The agent-browser command strings one scripted step expands to, in order:
 * an optional PRECONDITION wait, the command itself, then an optional
 * assertion wait.
 *
 * `waitBefore` exists because a rehearsed step is frequently only true of a
 * *settled* page, while replay arrives at a cold one. Rehearsal proves its
 * steps interactively — by the time the agent clicks, it has already been
 * snapshotting the page for several seconds — so an async list, a modal
 * animation or a lazy route has long since rendered. Replay opens `startUrl`
 * and fires the first command roughly one subprocess spawn later. Without a
 * precondition the script cannot say "this step is only valid once X is on
 * screen", and the difference shows up as a flat, deterministic
 * `Element not found` that no retry can fix.
 */
function buildStepCommands(action) {
  const cmds = []
  if (action.waitBefore) cmds.push(`wait ${action.waitBefore}`)
  cmds.push(action.cmd)
  if (action.assert) cmds.push(`wait ${action.assert}`)
  return cmds
}

/**
 * Decide whether one step landed. A command that errored is a deviation;
 * so is a command that succeeded while its assertion failed — that second
 * case is the one today's `actions-ok` check cannot see, because
 * agent-browser logs a click on the wrong element as `ok: true`.
 */
function classifyStep({ preResult, preCmd, cmdResult, assertResult }) {
  if (preResult && preResult.ok !== true) {
    return {
      status: "deviation",
      detail:
        `precondition ${preCmd ? `\`${preCmd}\` ` : ""}failed: ` +
        `${preResult.error || "unknown error"}`,
    }
  }
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
    (sum, a) =>
      sum +
      a.settleMs +
      ACTION_BASELINE_MS +
      (a.waitBefore ? ACTION_BASELINE_MS : 0),
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

    // A precondition gates the command: if the page never reaches the state
    // the step needs, the command is NOT attempted. Firing it anyway is what
    // produced the workik `Element not found` — a click into an unrendered
    // list, reported as if the selector were wrong.
    const preCmd = action.waitBefore ? `wait ${action.waitBefore}` : null
    const preResult = preCmd ? await exec([preCmd], { timeout: 15_000 }) : null

    let cmdResult = null
    let assertResult = null
    if (!preResult || preResult.ok === true) {
      cmdResult = await exec([action.cmd], { timeout: 30_000 })
      if (action.assert && cmdResult.ok === true) {
        assertResult = await exec([`wait ${action.assert}`], {
          timeout: 15_000,
        })
      }
    }

    const verdict = classifyStep({
      preResult,
      preCmd,
      cmdResult,
      assertResult,
    })
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
 * Shape: `[open <startUrl>]?` → `[wait <first precondition>]?` → `record
 * restart`.
 *
 * **Every take opens with `record restart`, not `record start`.** Both now
 * attach capture to the active page as-is, with no new context and no
 * navigation. `restart` also stops a take a failed attempt left running
 * (where `start` errors "Recording already active"), and with no take running
 * it simply starts one, so it is safe as the FIRST bracket of a run. Before
 * agent-browser v0.37, `record start` created a fresh browser context and
 * re-navigated, putting the app's cold boot on camera: 4.00s of black in a
 * 7.10s scene on the workik take.
 *
 * `--cursor --input-mode human` makes the take look like a person drove it:
 * the pointer is drawn into the video, and the input mode (a session default
 * from here on) glides the pointer to each target, types key by key and
 * pauses after clicks.
 *
 * This reverses the design spec's "independent = fresh browser context"
 * (decision 2). What that reset actually bought is already delivered by the
 * `open` above it — a real navigation destroys in-page state — while the
 * fresh context additionally *dropped* localStorage (only cookies are
 * copied) and recorded a duplicate of the authenticated context rather than
 * the authenticated context itself. `state.viewport` is only ever set by an
 * explicit `viewport`/`device` command, which this app never issues, so both
 * paths record at the browser's default size and nothing changes there.
 *
 * The first action's `waitBefore` is pre-rolled here, with the camera off,
 * so the take opens on a page that has already rendered. It is NOT skipped
 * during replay afterwards: `record restart` does not navigate, so re-running
 * it costs one subprocess and passes immediately — cheaper than coupling
 * `runScript` to what the bracket happened to do. Later actions' preconditions
 * stay on camera, where they belong: mid-scene, waiting for a modal or a
 * result is content the viewer should see.
 *
 * `preRollIndex` names that command's position so the caller can tell a
 * failed PRECONDITION apart from a failed `open`/`record`. The difference
 * decides whether a retry has any chance: a precondition failure means the
 * page was not in the scene's start state, which off-camera recovery can
 * often fix (sign in, dismiss an interstitial) in a way that SURVIVES the
 * retry's re-`open`, because it is session state rather than page state. A
 * failed `open` or `record` is infrastructure, and recovery has nothing to
 * work with. Without that distinction every attempt reruns the identical
 * bracket and fails identically — three attempts, no artifacts, no path to
 * success.
 *
 * NOTE: never pass `record restart` a URL. It would navigate the camera-on
 * page itself; navigation is what the `open` above it is for.
 */
/**
 * Everything a take needs BEFORE the camera starts: navigate to the start URL
 * (unless continuing a chained scene) and satisfy the scene's opening
 * precondition.
 *
 * Split out so the dress rehearsal (rehearse.ts) positions a scene exactly the
 * way the record pass does. If these two ever diverge, a script passes its
 * off-camera replay and then fails on camera — which is the whole failure mode
 * the dress rehearsal exists to eliminate.
 */
function positioningCommands({ script, isRetry }) {
  // A retry always re-opens: scene N's half-executed wreckage is not a valid
  // start state, so continuity is traded for idempotency on that take only.
  const reopens = script.continuity !== "chained" || isRetry === true
  const commands = []
  if (reopens) commands.push(`open ${quoteArg(script.startUrl)}`)
  const first = script.actions[0]
  if (first && first.waitBefore) commands.push(`wait ${first.waitBefore}`)
  return {
    commands,
    reopens,
    preRollIndex: first && first.waitBefore ? commands.length - 1 : null,
  }
}

function recordingBracket({ script, videoPath, actionsPath, isRetry }) {
  const { commands, reopens, preRollIndex } = positioningCommands({
    script,
    isRetry,
  })
  commands.push(
    `record restart ${quoteArg(videoPath)} --log-actions ${quoteArg(actionsPath)} --cursor --input-mode human`
  )
  return { commands, resetsPage: reopens, preRollIndex }
}

module.exports = {
  positioningCommands,
  normalizeScript,
  resolveParams,
  buildStepCommands,
  classifyStep,
  expectedDurationMs,
  runScript,
  DEFAULT_SETTLE_MS,
  ACTION_BASELINE_MS,
  recordingBracket,
  quoteArg,
}
