// ── The stall ladder, proven offline (ADR-013) ───────────────────────────────
//
//   bun run test:harness
//
// A real AgentController session, driven through the same session-driver the
// app and the smoke runner use, with a scripted model that does what a weak
// one does: says one line and stops. The watchdog has to get the run to a
// video without it — nudge, nudge, then salvage what rehearsal proved, or the
// floor scene when it proved nothing.
//
// Offline: the model is `mock:ends-early`, the browser is the fake one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), "demio-stall-"))

process.env.DEMIO_HOME = home
process.env.DEMIO_MOCK_MODEL = "1"
process.env.DEMIO_STALL_SETTLE_MS = "300"
process.env.DEMIO_AGENT_BROWSER_BIN = path.join(
  HERE,
  "workflows/fixtures/fake-agent-browser.cjs"
)
process.env.FAKE_AB_RECORD = path.join(home, "take.json")
delete process.env.FAKE_AB_SCENARIO
delete process.env.DEMIO_FAULT

type Driver = typeof import("./session-driver")
let driver: Driver
let store: typeof import("../store")
let ensureWorkspace: (threadId: string) => string

beforeAll(async () => {
  store = await import("../store")
  store.initStore()
  driver = await import("./session-driver")
  ensureWorkspace = (await import("./workspace")).ensureWorkspace
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const script = (sceneId: string) => ({
  sceneId,
  continuity: "independent",
  oneShot: false,
  startUrl: "https://example.test/",
  endUrl: "https://example.test/",
  params: {},
  actions: [
    { cmd: "scroll down 300", settleMs: 700 },
    { cmd: "scroll down 300", settleMs: 700 },
  ],
})

/** Start a thread whose rehearsal already got as far as `seed` says, then let the model stall. */
async function stall(seed: { flows: unknown[]; scripts: unknown[] }) {
  const { project, thread } = store.createProject("stall", "mock:ends-early", {
    domain: "example.test",
  })
  const workspace = ensureWorkspace(thread.id)
  const rehearsal = path.join(workspace, "rehearsal")
  fs.mkdirSync(rehearsal, { recursive: true })
  fs.writeFileSync(
    path.join(rehearsal, "checkpoint.json"),
    JSON.stringify({ version: 1, flows: seed.flows })
  )
  fs.writeFileSync(
    path.join(rehearsal, "scripts.json"),
    JSON.stringify({ version: 1, scripts: seed.scripts })
  )

  const key = `${project.id}:${thread.id}`
  const events: Array<Record<string, unknown>> = []
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `no video — events: ${events.map((e) => e["type"]).join(",")}`
          )
        ),
      50_000
    )
    driver.addSessionEventSink((k, event) => {
      if (k !== key) return
      const type = String(event["type"])
      if (type.startsWith("harness_") || type === "error") events.push(event)
      if (type === "harness_video_ready") {
        clearTimeout(timer)
        resolve(event)
      }
    })
  })
  await driver.sendMessage(project.id, thread.id, {
    text: "Make a demo of the homepage.",
    modelId: "mock:ends-early",
  })
  const ready = await done
  const runLine = fs
    .readFileSync(path.join(workspace, "scorecard.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e["kind"] === "run")
    .at(-1)!
  return { events, ready, runLine, workspace }
}

describe("a stalled model still ends with a video", () => {
  test("nudged twice, then the rehearsed scenes are salvaged", async () => {
    const r = await stall({
      flows: [
        {
          id: "home",
          label: "Homepage",
          startUrl: "https://example.test/",
          status: "done",
          sceneIds: ["home.01"],
          detail: "DONE",
        },
        {
          id: "pricing",
          label: "Pricing",
          startUrl: "https://example.test/pricing",
          status: "blocked",
          sceneIds: [],
          detail: "login wall",
        },
      ],
      scripts: [script("home.01")],
    })
    const types = r.events.map((e) => e["type"])
    expect(types.filter((t) => t === "harness_nudge")).toHaveLength(2)
    expect(types.indexOf("harness_salvage")).toBeGreaterThan(
      types.lastIndexOf("harness_nudge")
    )
    // The nudge is specific: it names what rehearsal proved and the next call.
    const nudge = String(
      r.events.find((e) => e["type"] === "harness_nudge")!["text"]
    )
    expect(nudge).toContain("home.01")
    expect(nudge).toContain("submit_plan")
    expect(nudge).toContain("pricing")

    expect(
      fs.statSync(path.join(r.workspace, "output/demo.mp4")).size
    ).toBeGreaterThan(0)
    expect(r.ready["scenes"]).toBe(1)
    expect(r.runLine["outcome"]).toBe("video")
    expect(r.runLine["salvaged"]).toBe(true)
    expect(r.runLine["nudges"]).toBe(2)
    expect(r.runLine["degraded"]).toEqual([])
  }, 60_000)

  test("nothing rehearsed → the floor video, reported as one", async () => {
    const r = await stall({
      flows: [
        {
          id: "home",
          label: "Homepage",
          startUrl: "https://example.test/",
          status: "blocked",
          sceneIds: [],
          detail: "bot wall",
        },
      ],
      scripts: [],
    })
    expect(r.events.filter((e) => e["type"] === "harness_nudge")).toHaveLength(
      2
    )
    expect(
      fs.statSync(path.join(r.workspace, "output/demo.mp4")).size
    ).toBeGreaterThan(0)
    expect(r.runLine["salvaged"]).toBe(true)
    expect(r.ready["scenes"]).toBe(1)
    // It recorded fine and it is still the fallback: reported as one.
    expect(
      (r.runLine["degraded"] as Array<{ stage: string }>).map((d) => d.stage)
    ).toEqual(["floor"])
    expect(r.runLine["pass"]).toBe(false)
  }, 60_000)
})
