#!/usr/bin/env bun
// ── smoke: run the demio agent headlessly, watch it, answer it ──────────────
//
//   bun run smoke start <scenario.json> [--model <id>] [--timeout <sec>] [--auto-approve-plan] [--unattended]
//   bun run smoke sweep [dir] [--model <id>] [--timeout <sec>]   every scenario, serially, unattended
//   bun run smoke watch  [runId] [--max-wait <sec>]   block until the run needs attention
//   bun run smoke answer <runId> <toolCallId> '<json|text>'
//   bun run smoke salvage [runId]                     a run ended with no video: record what it DID rehearse
//   bun run smoke report [runId]                      findings + where the evidence is
//   bun run smoke status [runId]
//   bun run smoke list
//   bun run smoke stop   [runId]
//
// Every command prints exactly one JSON object on stdout. `runId` defaults to
// the most recent run. The loop a coding agent runs:
//
//   start → watch → (answer → watch)* → done | stalled | error | timeout
//
// Exit codes: 0 ok · 1 the run ended without a clean video · 64 usage error.
// `watch` exits 0 on "waiting" — a gate is a question, not a failure.
// `report` exits 0 clean · 1 a video, with findings · 2 no video.

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
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

const findingsPure = createRequire(import.meta.url)(
  "../electron/agent/workflows/findings-pure.cjs"
) as {
  diagnose: (o: Record<string, unknown>) => Array<{
    code: string
    severity: "critical" | "warn" | "info"
  }>
  exitCode: (findings: unknown[]) => number
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

/** What the agent last said — for a stalled run, this is usually the whole explanation. */
function lastAssistantText(events: Array<Record<string, unknown>>): string {
  for (const event of [...events].reverse()) {
    if (event["type"] !== "message_end") continue
    const message = event["message"] as
      | { role?: string; content?: unknown }
      | undefined
    if (message?.role !== "assistant") continue
    const content = message.content as
      | { parts?: Array<{ type?: string; text?: string }> }
      | Array<{ type?: string; text?: string }>
      | undefined
    const parts = Array.isArray(content) ? content : (content?.parts ?? [])
    const text = parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n")
      .trim()
    if (text) return text.slice(-1500)
  }
  return ""
}

function existing(paths: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(paths).filter(([, p]) => fs.existsSync(p))
  )
}

function out(value: unknown, code = 0): never {
  console.log(JSON.stringify(value, null, 2))
  process.exit(code)
}

function fail(message: string): never {
  return out({ error: message }, 64)
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
    nudges: state.nudges,
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

async function startRun(
  scenarioPath: string | Scenario,
  salvage?: RunOptions["salvage"]
) {
  const scenario =
    typeof scenarioPath === "string"
      ? readJson<Scenario>(path.resolve(scenarioPath))
      : scenarioPath
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
      (flags["model"] as string) || scenario.modelId || SMOKE_DEFAULT_MODEL_ID,
    timeoutSec: Number(flags["timeout"]) || SMOKE_DEFAULT_TIMEOUT_SEC,
    unattended: flags["unattended"] === true,
    salvage,
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
  for (let i = 0; i < 100 && !fs.existsSync(files.state); i++) await sleep(100)
  return {
    runId,
    pid: child.pid,
    modelId: options.modelId,
    timeoutSec: options.timeoutSec,
    dir,
  }
}

function reportFor(runId: string) {
  const raw = readState(runId)
  if (!raw) fail(`no such run: ${runId}`)
  const state = withLiveness(raw)
  const files = runFiles(runDir(runId))
  const options = readJson<RunOptions>(files.options)
  const workspace = state.workspace ?? ""
  const scorecard = path.join(workspace, "scorecard.jsonl")
  const events = readJsonl(files.events)
  const findings = findingsPure.diagnose({
    entries: readJsonl(scorecard),
    run: state,
    scenario: options?.scenario,
    paths: {
      workspace,
      scorecard,
      events: files.events,
      runnerLog: files.log,
    },
  })
  const count = (severity: string) =>
    findings.filter((f) => f.severity === severity).length
  return {
    runId,
    scenario: state.scenarioId,
    state: state.phase,
    modelId: state.modelId,
    elapsedSec: state.elapsedSec,
    video: state.video ?? null,
    verdict:
      findingsPure.exitCode(findings) === 0
        ? "clean"
        : findingsPure.exitCode(findings) === 2
          ? "no-video"
          : "video-with-findings",
    summary: {
      critical: count("critical"),
      warn: count("warn"),
      info: count("info"),
      turns: state.turns,
      toolCalls: state.toolCalls,
      gates: state.gateLog.map((g) => ({
        tool: g.tool,
        answeredBy: g.answeredBy,
        question: g.question,
      })),
    },
    findings,
    lastAssistantText: lastAssistantText(events),
    artifacts: existing({
      workspace,
      scorecard,
      events: files.events,
      runnerLog: files.log,
      plans: path.join(workspace, "plans"),
      scripts: path.join(workspace, "rehearsal", "scripts.json"),
      checkpoint: path.join(workspace, "rehearsal", "checkpoint.json"),
      rehearsalFindings: path.join(workspace, "rehearsal", "findings.md"),
      scenes: path.join(workspace, "scenes"),
      logs: path.join(workspace, "logs"),
    }),
    more: {
      scorecard: `DEMIO_HOME=${smokeHome()} bun run scorecard ${state.threadId ?? ""}`,
      conversation: `DEMIO_HOME=${smokeHome()} node scripts/dump-thread.js ${state.threadId ?? ""} --full`,
      subAgents: `DEMIO_HOME=${smokeHome()} node scripts/dump-thread.js ${state.threadId ?? ""} --agents`,
    },
  }
}

switch (command) {
  case "start": {
    const scenarioPath = rest[0]
    if (!scenarioPath) fail("usage: smoke start <scenario.json>")
    const started = await startRun(scenarioPath)
    out({ ...started, next: `bun run smoke watch ${started.runId}` })
    break
  }

  case "sweep": {
    const dir = path.resolve(rest[0] ?? path.join(HERE, "scenarios"))
    const scenarios = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
    const results = []
    // Serial: one browser daemon, and the runner's lock refuses a second run.
    for (const file of scenarios) {
      flags["unattended"] = true
      const { runId } = await startRun(path.join(dir, file))
      let state = readState(runId)
      while (state && !TERMINAL_PHASES.has(withLiveness(state).phase)) {
        await sleep(2000)
        state = readState(runId)
      }
      const report = reportFor(runId)
      results.push({
        scenario: file,
        runId,
        state: report.state,
        verdict: report.verdict,
        elapsedSec: report.elapsedSec,
        video: report.video,
        findings: report.findings.map((f) => `${f.severity}:${f.code}`),
      })
      console.error(
        `[sweep] ${file}: ${report.verdict} (${report.elapsedSec}s)`
      )
    }
    const delivered = results.filter((r) => r.video).length
    out(
      { delivered: `${delivered}/${results.length}`, results },
      delivered === results.length ? 0 : 1
    )
    break
  }

  case "watch": {
    const runId = resolveRunId(rest[0])
    const maxWaitMs = (Number(flags["max-wait"]) || 540) * 1000
    const deadline = Date.now() + maxWaitMs
    // An answered gate is not news, though the runner may not have taken the
    // answer yet (`answer` drops <id>.json; the runner renames it .taken).
    const inbox = runFiles(runDir(runId)).inbox
    const answered = (toolCallId: string) =>
      fs.existsSync(path.join(inbox, `${toolCallId}.json`)) ||
      fs.existsSync(path.join(inbox, `${toolCallId}.json.taken`))
    for (;;) {
      const raw = readState(runId)
      if (!raw) fail(`no such run: ${runId}`)
      const live = withLiveness(raw)
      const state = {
        ...live,
        gates: live.gates.filter((g) => !answered(g.toolCallId)),
      }
      const isNews =
        TERMINAL_PHASES.has(state.phase) ||
        (ATTENTION_PHASES.has(state.phase) && state.gates.length > 0)
      if (isNews) {
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

  case "salvage": {
    const fromRunId = resolveRunId(rest[0])
    const from = readState(fromRunId)
    const options = readJson<RunOptions>(runFiles(runDir(fromRunId)).options)
    if (!from?.projectId || !from.threadId || !options) {
      fail(`run ${fromRunId} never got as far as a thread — nothing to salvage`)
    }
    if (!TERMINAL_PHASES.has(withLiveness(from).phase)) {
      fail(`run ${fromRunId} is still going — \`smoke stop\` it first`)
    }
    const started = await startRun(options.scenario, {
      projectId: from.projectId,
      threadId: from.threadId,
      fromRunId,
    })
    out({
      ...started,
      salvaging: fromRunId,
      next: `bun run smoke watch ${started.runId}`,
    })
    break
  }

  case "report": {
    const report = reportFor(resolveRunId(rest[0]))
    out(report, findingsPure.exitCode(report.findings))
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
      "usage: smoke <start|sweep|salvage|watch|answer|report|status|list|stop> … — see the header of smoke/cli.ts"
    )
}
