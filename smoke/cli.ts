#!/usr/bin/env bun
// ── smoke: run the demio agent headlessly, watch it, answer it ──────────────
//
//   bun run smoke start <scenario.json> [--model <id>] [--timeout <sec>] [--auto-approve-plan]
//   bun run smoke watch  [runId] [--max-wait <sec>]   block until the run needs attention
//   bun run smoke answer <runId> <toolCallId> '<json|text>'
//   bun run smoke status [runId]
//   bun run smoke list
//   bun run smoke stop   [runId]
//
// Every command prints exactly one JSON object on stdout. `runId` defaults to
// the most recent run. The loop a coding agent runs:
//
//   start → watch → (answer → watch)* → done | stalled | error | timeout
//
// Exit codes: 0 ok · 1 the run ended without a clean video · 2 usage error.
// `watch` exits 0 on "waiting" — a gate is a question, not a failure.

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  ATTENTION_PHASES,
  SMOKE_DEFAULT_MODEL_ID,
  SMOKE_DEFAULT_TIMEOUT_SEC,
  TERMINAL_PHASES,
  listRunIds,
  newRunId,
  pidAlive,
  readJson,
  readState,
  runDir,
  runFiles,
  smokeHome,
  writeJsonAtomic,
  type RunOptions,
  type RunState,
  type Scenario,
} from "./lib"

const HERE = path.dirname(fileURLToPath(import.meta.url))

function out(value: unknown, code = 0): never {
  console.log(JSON.stringify(value, null, 2))
  process.exit(code)
}

function fail(message: string): never {
  return out({ error: message }, 2)
}

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) flags[arg.slice(2)] = true
    else flags[arg.slice(2)] = argv[++i]
  }
  return { positional, flags }
}

function resolveRunId(given: string | undefined): string {
  const runId = given ?? listRunIds()[0]
  if (!runId) fail("no smoke runs yet — `smoke start <scenario.json>`")
  return runId
}

/** A runner that died without writing a terminal state must not read as "running" forever. */
function withLiveness(state: RunState): RunState {
  if (TERMINAL_PHASES.has(state.phase) || pidAlive(state.pid)) return state
  return {
    ...state,
    phase: "error",
    detail: `runner process ${state.pid} is gone without a final state — see runner.log`,
  }
}

function view(state: RunState) {
  const files = runFiles(runDir(state.runId))
  return {
    runId: state.runId,
    scenario: state.scenarioId,
    state: state.phase,
    ...(state.gates.length > 0 ? { gate: state.gates[0] } : {}),
    ...(state.gates.length > 1 ? { moreGates: state.gates.length - 1 } : {}),
    ...(state.video ? { video: state.video } : {}),
    ...(state.detail ? { detail: state.detail } : {}),
    elapsedSec: state.elapsedSec,
    modelId: state.modelId,
    activeTools: state.activeTools,
    turns: state.turns,
    toolCalls: state.toolCalls,
    gatesAnswered: state.gateLog.length,
    errors: state.errors.slice(-3),
    workspace: state.workspace,
    threadId: state.threadId,
    files: { events: files.events, log: files.log },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const { positional, flags } = parseArgs(process.argv.slice(2))
const [command, ...rest] = positional

switch (command) {
  case "start": {
    const scenarioPath = rest[0]
    if (!scenarioPath) fail("usage: smoke start <scenario.json>")
    const scenario = readJson<Scenario>(path.resolve(scenarioPath))
    if (!scenario?.id || !scenario.domain || !scenario.prompt) {
      fail(`${scenarioPath}: a scenario needs id, domain and prompt`)
    }
    if (flags["auto-approve-plan"]) scenario.approvePlan = "auto"

    const runId = newRunId()
    const dir = runDir(runId)
    fs.mkdirSync(dir, { recursive: true })
    const options: RunOptions = {
      runId,
      scenario,
      modelId:
        (flags["model"] as string) ||
        scenario.modelId ||
        SMOKE_DEFAULT_MODEL_ID,
      timeoutSec: Number(flags["timeout"]) || SMOKE_DEFAULT_TIMEOUT_SEC,
      home: smokeHome(),
      startedAt: new Date().toISOString(),
    }
    const files = runFiles(dir)
    writeJsonAtomic(files.options, options)

    const log = fs.openSync(files.log, "a")
    const child = spawn(process.execPath, [path.join(HERE, "runner.ts"), dir], {
      cwd: path.resolve(HERE, ".."),
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    })
    child.unref()

    // Wait for the runner's first state write so a broken start is reported
    // here, not discovered by a `watch` that never returns.
    for (let i = 0; i < 100 && !fs.existsSync(files.state); i++)
      await sleep(100)
    out({
      runId,
      pid: child.pid,
      modelId: options.modelId,
      timeoutSec: options.timeoutSec,
      dir,
      next: `bun run smoke watch ${runId}`,
    })
    break
  }

  case "watch": {
    const runId = resolveRunId(rest[0])
    const maxWaitMs = (Number(flags["max-wait"]) || 540) * 1000
    const deadline = Date.now() + maxWaitMs
    // A "waiting" state this caller has already been shown is not news: only
    // return on it again once the runner has moved (seq) past it.
    const seenFile = path.join(runDir(runId), "watch.seen")
    const seen = Number(readJson<number>(seenFile) ?? -1)
    for (;;) {
      const raw = readState(runId)
      if (!raw) fail(`no such run: ${runId}`)
      const state = withLiveness(raw)
      const isNews =
        TERMINAL_PHASES.has(state.phase) ||
        (ATTENTION_PHASES.has(state.phase) && state.seq > seen)
      if (isNews) {
        writeJsonAtomic(seenFile, state.seq)
        out(
          view(state),
          state.phase === "done" || state.phase === "waiting" ? 0 : 1
        )
      }
      if (Date.now() > deadline) {
        // Not an error: the caller's own shell has a time limit. Call again.
        out({
          ...view(state),
          stillRunning: true,
          next: `bun run smoke watch ${runId}`,
        })
      }
      await sleep(1000)
    }
  }

  case "answer": {
    const [runIdArg, toolCallId, ...answerParts] = rest
    const raw = answerParts.join(" ")
    if (!runIdArg || !toolCallId || !raw) {
      fail("usage: smoke answer <runId> <toolCallId> '<json|text>'")
    }
    const state = readState(runIdArg)
    if (!state) fail(`no such run: ${runIdArg}`)
    const gate = state.gates.find((g) => g.toolCallId === toolCallId)
    if (!gate) {
      fail(
        `run ${runIdArg} has no open gate ${toolCallId} (open: ${
          state.gates.map((g) => g.toolCallId).join(", ") || "none"
        })`
      )
    }
    // ask_user takes a plain string; submit_plan takes {action, feedback?}.
    // Accept either without making the caller quote JSON strings.
    let resumeData: unknown
    try {
      resumeData = JSON.parse(raw)
    } catch {
      resumeData = raw
    }
    if (gate.tool === "submit_plan" && typeof resumeData === "string") {
      resumeData = /^(approve|approved|yes|ok)$/i.test(resumeData.trim())
        ? { action: "approved" }
        : { action: "rejected", feedback: resumeData }
    }
    const inbox = runFiles(runDir(runIdArg)).inbox
    writeJsonAtomic(path.join(inbox, `${toolCallId}.json`), {
      toolCallId,
      resumeData,
    })
    out({
      ok: true,
      tool: gate.tool,
      resumeData,
      next: `bun run smoke watch ${runIdArg}`,
    })
    break
  }

  case "status": {
    const state = readState(resolveRunId(rest[0]))
    if (!state) fail("no such run")
    out(view(withLiveness(state)))
    break
  }

  case "list": {
    out({
      home: smokeHome(),
      runs: listRunIds()
        .slice(0, 20)
        .map((id) => readState(id))
        .filter((s): s is RunState => s !== null)
        .map(withLiveness)
        .map((s) => ({
          runId: s.runId,
          scenario: s.scenarioId,
          state: s.phase,
          modelId: s.modelId,
          startedAt: s.startedAt,
          elapsedSec: s.elapsedSec,
          video: s.video,
        })),
    })
    break
  }

  case "stop": {
    const state = readState(resolveRunId(rest[0]))
    if (!state) fail("no such run")
    if (TERMINAL_PHASES.has(state.phase) || !pidAlive(state.pid)) {
      out({ ok: true, alreadyStopped: true, state: state.phase })
    }
    process.kill(state.pid, "SIGTERM")
    out({ ok: true, signalled: state.pid })
    break
  }

  default:
    fail(
      "usage: smoke <start|watch|answer|status|list|stop> … — see the header of smoke/cli.ts"
    )
}
