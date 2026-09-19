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
