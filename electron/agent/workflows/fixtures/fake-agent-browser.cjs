#!/usr/bin/env node
// A stand-in for the agent-browser CLI, for evals.
//
// Answers every invocation from a scenario file (FAKE_AB_SCENARIO): an
// ordered list of rules `{ match, exit?, stdout?, stderr?, delayMs?,
// activates?, requires? }`, first regex match against the joined argv wins,
// no match → exit 0 with "ok". A rule with `activates: "<flag>"` records
// that flag in `<scenario>.state.json` when it fires; a rule with
// `requires: "<flag>"` only matches once that flag is set. That is enough
// state for "the dialog is gone after you click Got it" — put the
// `requires` rule before the plain one.
// Appends one JSON line per invocation to FAKE_AB_LOG so an eval can read
// back exactly which commands the agent ran — including the ones the replay
// engine ran to validate an amendment.
//
// With FAKE_AB_RECORD set (to a state-file path) it also plays the camera, for
// the harness tests that run the whole demo-video workflow offline:
// `record restart <video> --log-actions <log>` starts a take, every command
// after it is appended to the action log the way the real CLI's
// `--log-actions` does, and `record stop` renders a real test-pattern clip as
// long as the take ran — so verify, the EDL and the compose concat all work on
// a genuine file. Unset, none of this runs and the fake is what it always was.
//
// Reached two ways, matching production: `execAgentBrowser` spawns it
// directly (DEMIO_AGENT_BROWSER_BIN), and the agent's shell finds it on PATH
// through the sandbox shim, which links whatever `resolveBinaryPath` returns.

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

// Where the scenario and log live. Env vars when present (the replay
// engine's direct spawns inherit the eval's env) — otherwise a pointer file
// in the temp dir. The pointer exists because the agent's SHELL no longer
// inherits arbitrary env: the sandbox env is an allowlist
// (`sandbox-env-pure.cjs`), and FAKE_AB_* is rightly not on it. TMPDIR is,
// so both spawn paths agree on where the pointer is.
const POINTER = path.join(os.tmpdir(), "demio-fake-agent-browser.json")
let pointer = {}
if (!process.env.FAKE_AB_SCENARIO && fs.existsSync(POINTER)) {
  try {
    pointer = JSON.parse(fs.readFileSync(POINTER, "utf8"))
  } catch {
    pointer = {}
  }
}

const argv = process.argv.slice(2)
const command = argv.join(" ")

const scenarioPath = process.env.FAKE_AB_SCENARIO || pointer.scenario
const logPath = process.env.FAKE_AB_LOG || pointer.log
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ command, at: Date.now() }) + "\n")
}

let rules = []
if (scenarioPath) {
  try {
    rules = JSON.parse(fs.readFileSync(scenarioPath, "utf8")).rules || []
  } catch (err) {
    process.stderr.write(`fake-agent-browser: bad scenario: ${err.message}\n`)
    process.exit(2)
  }
}

const statePath = scenarioPath ? `${scenarioPath}.state.json` : null
let state = []
if (statePath && fs.existsSync(statePath)) {
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"))
  } catch {
    state = []
  }
}
const rule = rules.find(
  (r) =>
    (!r.requires || state.includes(r.requires)) &&
    new RegExp(r.match).test(command)
)
if (rule && rule.activates && statePath && !state.includes(rule.activates)) {
  fs.writeFileSync(statePath, JSON.stringify([...state, rule.activates]))
}
const exit = rule && typeof rule.exit === "number" ? rule.exit : 0
const stdout = rule && rule.stdout !== undefined ? rule.stdout : "ok"
const stderr = rule && rule.stderr ? rule.stderr : ""

// ── Camera (opt-in) ─────────────────────────────────────────────────────────
const recordState = process.env.FAKE_AB_RECORD
if (recordState && exit === 0) {
  const unquote = (v) => (v || "").replace(/^'(.*)'$/, "$1")
  let take = null
  try {
    take = JSON.parse(fs.readFileSync(recordState, "utf8"))
  } catch {
    take = null
  }
  const restart =
    /^record (?:re)?start ('[^']+'|\S+)(?: --log-actions ('[^']+'|\S+))?/.exec(
      command
    )
  if (restart) {
    const next = {
      video: unquote(restart[1]),
      actions: unquote(restart[2]),
      startedAt: Date.now(),
    }
    fs.mkdirSync(path.dirname(next.video), { recursive: true })
    if (next.actions) fs.writeFileSync(next.actions, "")
    fs.writeFileSync(recordState, JSON.stringify(next))
  } else if (command === "record stop") {
    if (take) {
      const sec = Math.max(1, (Date.now() - take.startedAt) / 1000).toFixed(2)
      // testsrc, not a solid colour: the black-frame check must see a picture.
      require("node:child_process").execFileSync(
        process.env.FAKE_AB_FFMPEG || "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          `testsrc=duration=${sec}:size=320x200:rate=30`,
          "-c:v",
          "libvpx",
          "-b:v",
          "200k",
          take.video,
        ]
      )
      fs.rmSync(recordState, { force: true })
    }
  } else if (
    take &&
    take.actions &&
    !/^(wait|get|snapshot|is|eval)\b/.test(command)
  ) {
    fs.appendFileSync(
      take.actions,
      JSON.stringify({
        action: argv[0],
        args: { selector: argv[1] || null },
        durationMs: 0,
        ok: true,
        tsMs: Date.now() - take.startedAt,
      }) + "\n"
    )
  }
}

setTimeout(
  () => {
    if (stdout)
      process.stdout.write(stdout + (stdout.endsWith("\n") ? "" : "\n"))
    if (stderr)
      process.stderr.write(stderr + (stderr.endsWith("\n") ? "" : "\n"))
    process.exit(exit)
  },
  rule && rule.delayMs ? rule.delayMs : 0
)
