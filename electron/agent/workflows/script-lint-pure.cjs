// ── Scene script linter (pure) ──────────────────────────────────────────────
//
// Static checks on a `SceneScript`, run at WRITE time (`recordScript`,
// `amend_scene_script`) so a bad script is rejected while the agent that
// wrote it still has the page in front of it — not three recorded takes
// later. Every rule traces to a take that failed for real; see the fixtures
// directory and `script-lint.test.js`.
//
// `checkReplayDuration` is the one rule that needs a replay to have run. It
// is what the dress rehearsal and amendment validation use to reject a script
// that replays *cleanly* but would still fail the take's duration check —
// the case where every step reports success and the artifact is still wrong.
//
// Pure: no imports beyond the sibling .cjs modules, so `node --test` loads it
// directly. Mirrors the replay-pure / artifact-pure split.

const { expectedDurationMs } = require("./replay-pure.cjs")
const { checkComputedDuration } = require("./artifact-pure.cjs")

/** Load states agent-browser's `WaitUntil::from_str` actually recognises.
 * Anything else silently falls through to `load` (browser.rs:257-260). */
const LOAD_STATES = new Set(["load", "domcontentloaded", "networkidle", "none"])

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

function fieldsOf(action) {
  return [
    ["cmd", action.cmd],
    ["waitBefore", action.waitBefore],
    ["assert", action.assert],
  ].filter(([, v]) => typeof v === "string" && v.length > 0)
}

function loadStateOf(text) {
  const m = /(?:^|\s)(?:--load|-l)\s+("?)([^\s"]+)\1/.exec(text)
  return m ? m[2] : null
}

function mentionsLoadWait(text) {
  return /(?:^|\s)(?:--load|-l)(?:\s|$)/.test(text)
}

/**
 * Static lint. Returns every finding, not just the first, so the agent can
 * fix a script in one pass.
 */
function lintScript(script) {
  const findings = []
  const add = (rule, index, detail, blocking = true) =>
    findings.push({ rule, index, detail, blocking })
  const actions = Array.isArray(script.actions) ? script.actions : []

  actions.forEach((action, index) => {
    for (const [field, text] of fieldsOf(action)) {
      // Snapshot refs do not survive a page load. A script full of them
      // fails on replay in a way that looks random (checklist item 36).
      if (/@e\d+\b/.test(text)) {
        add(
          "stale-ref",
          index,
          `${field} uses a snapshot ref (\`${text}\`) — refs do not survive a ` +
            `page load; use a durable selector`
        )
      }
      const state = loadStateOf(text)
      if (state && !LOAD_STATES.has(state)) {
        add(
          "unknown-load-state",
          index,
          `${field} waits for load state "${state}", which agent-browser does ` +
            `not know (it silently falls back to "load"). Use one of: ` +
            `${[...LOAD_STATES].join(", ")}`
        )
      }
    }

    // A password never belongs in a script — the vault signs in off camera.
    if (/^(fill|type)\s/.test(action.cmd) && /password/i.test(action.cmd)) {
      add(
        "password-fill",
        index,
        `cmd fills a password field (\`${action.cmd}\`). Credentials are ` +
          `never typed by a script; sign in with \`auth login <profile>\``
      )
    }
  })

  // Positioning already runs `open <startUrl>` and the first precondition
  // before the camera starts. Repeating either as the first ACTION does not
  // re-prove anything — and a `wait --load` on a page that has already
  // loaded waits for an event that never comes: agent-browser's wait
  // discards its own timeout and reports success after ~25 s of dead air.
  // That was every take of electron-chromium-talk.01.
  const first = actions[0]
  if (first) {
    if (/^open(\s|$)/.test(first.cmd)) {
      add(
        "leading-open",
        0,
        `the first action is \`${first.cmd}\` — positioning already opens ` +
          `startUrl before the camera starts; a script begins at the first ` +
          `thing the viewer should see happen`
      )
    }
    if (/^wait(\s|$)/.test(first.cmd) && mentionsLoadWait(first.cmd)) {
      add(
        "leading-load-wait",
        0,
        `the first action is \`${first.cmd}\` on a page positioning has ` +
          `already loaded. The next load event never comes, agent-browser ` +
          `reports success anyway, and the take is ~25 s of a static page. ` +
          `Replace it with an observation that proves the start state ` +
          `(\`wait --selector …\` / \`--text …\`), or drop it if the scene's ` +
          `first real action already carries a waitBefore`
      )
    }
    if (first.waitBefore && mentionsLoadWait(first.waitBefore)) {
      add(
        "leading-load-wait",
        0,
        `the first action's waitBefore (\`${first.waitBefore}\`) is a load ` +
          `wait. Positioning runs that exact precondition once already; ` +
          `replay runs it a second time on a loaded page and waits ~25 s for ` +
          `nothing. Wait for the element the step needs instead`
      )
    }
  }

  // `{{name}}` in a command must have a value, and every value must be used —
  // an unused value usually means the record pass is about to type the same
  // data rehearsal typed (checklist item 37).
  const params =
    script.params && typeof script.params === "object" ? script.params : {}
  const used = new Set()
  actions.forEach((action, index) => {
    for (const [field, text] of fieldsOf(action)) {
      for (const m of text.matchAll(PLACEHOLDER)) {
        used.add(m[1])
        if (!(m[1] in params)) {
          add(
            "unbound-param",
            index,
            `${field} uses {{${m[1]}}} but params has no value for it`
          )
        }
      }
    }
  })
  for (const key of Object.keys(params)) {
    if (!used.has(key)) {
      // Advisory, not blocking: `record_scene_script` is called after every
      // proven step, so a param declared before the step that uses it is the
      // normal incremental state; and `resolveParams` hands recovery a script
      // whose actions are already substituted while `params` survives. Both
      // would be false rejections. The dress rehearsal sees the final script.
      add(
        "unused-param",
        null,
        `params.${key} is set but no command uses {{${key}}} — if that is ` +
          `still true when the flow is done, the record pass replays ` +
          `rehearsal's own data`,
        false
      )
    }
  }

  return { ok: findings.every((f) => !f.blocking), findings }
}

/** One line per finding, for tool errors and log lines. */
function formatFindings(findings) {
  return findings
    .map(
      (f) =>
        `[${f.rule}${f.index === null ? "" : ` @${f.index}`}${f.blocking ? "" : " (advisory)"}] ${f.detail}`
    )
    .join("\n")
}

/**
 * Would a take of this replay pass the duration check?
 *
 * `steps` are the replay engine's per-step records (`durationMs` is stamped
 * BEFORE the settle sleep), so the predicted take is their sum plus every
 * settle. The band is `checkComputedDuration` against `expectedDurationMs` —
 * the exact call `verify.ts` makes on the recorded file, so a script that
 * passes here passes there and one that fails here fails there.
 */
function checkReplayDuration(script, steps) {
  const stepMs = steps.reduce((s, x) => s + (x.durationMs || 0), 0)
  const settleMs = script.actions.reduce((s, a) => s + (a.settleMs || 0), 0)
  const predictedMs = stepMs + settleMs
  const expectedMs = expectedDurationMs(script)
  const band = checkComputedDuration(predictedMs / 1000, expectedMs / 1000)
  const slowest = steps.reduce(
    (best, x) =>
      best === null || (x.durationMs || 0) > best.durationMs
        ? { index: x.index, cmd: x.cmd, durationMs: x.durationMs || 0 }
        : best,
    null
  )
  return {
    ok: band.ok,
    detail: band.ok
      ? band.detail
      : `${band.detail}; slowest step ${slowest ? slowest.index : "?"} ` +
        `(\`${slowest ? slowest.cmd : ""}\`) took ${((slowest ? slowest.durationMs : 0) / 1000).toFixed(1)}s`,
    predictedMs,
    expectedMs,
    slowest,
  }
}

const DEFAULT_SETTLE_MS = 600

/** The fields an amendment is compared on, with the schema default applied. */
function normalizeAction(a) {
  const out = {
    cmd: a.cmd,
    settleMs: typeof a.settleMs === "number" ? a.settleMs : DEFAULT_SETTLE_MS,
  }
  if (typeof a.waitBefore === "string") out.waitBefore = a.waitBefore
  if (typeof a.assert === "string") out.assert = a.assert
  if (typeof a.narrationAnchor === "number")
    out.narrationAnchor = a.narrationAnchor
  return out
}

function sameAction(a, b) {
  return (
    JSON.stringify(normalizeAction(a)) === JSON.stringify(normalizeAction(b))
  )
}

/**
 * Is `amended` a legitimate rewrite of `original` at `index`?
 *
 * "Change only what is broken" as a mechanical rule: every action before the
 * failing one and every action after it must come back byte-for-byte — every
 * field, `assert` and `settleMs` included. The failing step may be replaced
 * by one or more steps, never by none. And if the failing step carried an
 * assertion, its replacement must end with one: a rewrite that quietly drops
 * the proof turns a proven step into an unproven one.
 *
 * Exists because the recovery agent, asked to fix step 0 of a two-step
 * scene, handed back both steps rewritten from memory with every `assert`
 * missing — a script that replays "cleanly" precisely because it no longer
 * checks anything.
 */
function checkAmendment(original, amended, index) {
  const before = original.slice(0, index)
  const after = original.slice(index + 1)
  if (amended.length < before.length + 1 + after.length) {
    return {
      ok: false,
      detail:
        `the amended script has ${amended.length} action(s), fewer than the ` +
        `${original.length} it started with. Fix step ${index}; do not remove it.`,
    }
  }
  for (let i = 0; i < before.length; i++) {
    if (!sameAction(before[i], amended[i])) {
      return {
        ok: false,
        detail:
          `step ${i} was changed but step ${index} is the one that failed. ` +
          `Pass every other step back exactly as it was — every field, ` +
          `including assert and settleMs. Was: ${JSON.stringify(normalizeAction(before[i]))}`,
      }
    }
  }
  const replacement = amended.slice(
    before.length,
    amended.length - after.length
  )
  for (let i = 0; i < after.length; i++) {
    const j = amended.length - after.length + i
    if (!sameAction(after[i], amended[j])) {
      return {
        ok: false,
        detail:
          `step ${index + 1 + i} (now at ${j}) was changed but step ${index} is ` +
          `the one that failed. Pass every other step back exactly as it was — ` +
          `every field, including assert and settleMs. Was: ` +
          `${JSON.stringify(normalizeAction(after[i]))}`,
      }
    }
  }
  const failing = original[index]
  const last = replacement[replacement.length - 1]
  if (
    failing &&
    typeof failing.assert === "string" &&
    !(last && typeof last.assert === "string")
  ) {
    return {
      ok: false,
      detail:
        `the failing step asserted \`${failing.assert}\` and its replacement asserts ` +
        `nothing. Keep that assertion, or replace it with one that proves the ` +
        `rewritten step landed — a step with no assertion is a step nobody proved.`,
    }
  }
  return {
    ok: true,
    detail: `step ${index} replaced by ${replacement.length} action(s)`,
  }
}

module.exports = {
  lintScript,
  formatFindings,
  checkReplayDuration,
  checkAmendment,
  LOAD_STATES,
}
