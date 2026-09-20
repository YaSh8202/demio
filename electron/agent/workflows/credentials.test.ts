// The first successful sign-in in a fresh Chrome leaves the tab deaf: clicks
// and key presses are acknowledged and dropped, while `eval` still works. A
// same-site navigation does not clear it; one off-site bounce does, for good.
// In a demo that first sign-in is `save_login`'s own test login — so it
// "verified", and everything after it clicked into nothing. Found by a smoke
// run on saucedemo; reproduced with Chrome alone over raw CDP.
//
//   bun run test:harness

import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demio-cred-test-"))
const scenario = path.join(dir, "scenario.json")
const logPath = path.join(dir, "commands.jsonl")
process.env.DEMIO_AGENT_BROWSER_BIN = path.join(
  import.meta.dir,
  "fixtures",
  "fake-agent-browser.cjs"
)
process.env.FAKE_AB_SCENARIO = scenario
process.env.FAKE_AB_LOG = logPath

const workspace = path.join(dir, "workspaces", "thread-1")
const LANDING = "https://shop.test/inventory.html"

const commands = () =>
  fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { command: string }).command)

function browser(rules: object[]) {
  fs.rmSync(`${scenario}.state.json`, { force: true })
  fs.rmSync(logPath, { force: true })
  fs.writeFileSync(scenario, JSON.stringify({ rules }))
}

const signedIn = [
  { match: "^auth login", stdout: "✓ Logged in" },
  { match: "input\\[type=password\\]", stdout: "false" },
  { match: "^get url", stdout: LANDING },
]

beforeEach(() => fs.mkdirSync(workspace, { recursive: true }))

describe("a vault login", () => {
  test("a tab left deaf by the sign-in is revived, back where it landed", async () => {
    browser([
      ...signedIn,
      { match: "^open about:blank", activates: "bounced" },
      { match: "__demioInput===1", requires: "bounced", stdout: "true" },
      { match: "__demioInput===1", stdout: "false" },
    ])
    const { loginProfile } = await import("./credentials")
    const res = await loginProfile(workspace)

    expect(res.ok).toBe(true)
    const ran = commands()
    const bounce = ran.findIndex((c) => c.startsWith("open about:blank"))
    expect(bounce).toBeGreaterThan(-1)
    expect(ran[bounce + 1]).toBe(`open ${LANDING}`)
  })

  test("a tab that hears input is left alone", async () => {
    browser([...signedIn, { match: "__demioInput===1", stdout: "true" }])
    const { loginProfile } = await import("./credentials")
    const res = await loginProfile(workspace)

    expect(res.ok).toBe(true)
    expect(commands().some((c) => c.startsWith("open"))).toBe(false)
  })

  test("a probe that cannot run is not evidence — no bounce", async () => {
    browser([...signedIn, { match: "^mouse move", exit: 1, stderr: "nope" }])
    const { loginProfile } = await import("./credentials")
    const res = await loginProfile(workspace)

    expect(res.ok).toBe(true)
    expect(commands().some((c) => c.startsWith("open"))).toBe(false)
  })
})
