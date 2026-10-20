// `watch` must not hand back a gate that was already answered: the runner
// takes an answer from its inbox up to 500ms later, and saves state every 15s
// meanwhile — so the answered gate is still in state.json, under a newer save.
//
//   bun run test:harness

import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-cli-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

function waitingRun(runId: string, inboxFile?: string) {
  const dir = path.join(home, "smoke-runs", runId)
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      runId,
      scenarioId: "test",
      phase: "waiting",
      pid: process.pid,
      gates: [{ tool: "submit_plan", toolCallId: "g1" }],
      gateLog: [],
      activeTools: [],
      errors: [],
    })
  )
  if (inboxFile) fs.writeFileSync(path.join(dir, "inbox", inboxFile), "{}")
}

function watch(runId: string) {
  const proc = Bun.spawnSync(
    [
      "bun",
      path.join(import.meta.dir, "cli.ts"),
      "watch",
      runId,
      "--max-wait",
      "1",
    ],
    { env: { ...process.env, DEMIO_SMOKE_HOME: home } }
  )
  return JSON.parse(proc.stdout.toString())
}

test("watch returns an open gate nobody has answered", () => {
  waitingRun("open")
  const view = watch("open")
  expect(view.gate?.toolCallId).toBe("g1")
  expect(view.stillRunning).toBeUndefined()
})

test.each(["g1.json", "g1.json.taken"])(
  "watch does not return a gate answered with %s",
  (inboxFile) => {
    const runId = `answered-${inboxFile}`
    waitingRun(runId, inboxFile)
    const view = watch(runId)
    expect(view.stillRunning).toBe(true)
    expect(view.gate).toBeUndefined()
  }
)
