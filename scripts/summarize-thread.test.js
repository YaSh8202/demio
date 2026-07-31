#!/usr/bin/env node
// Smoke test for summarize-thread.js. Run with: node summarize-thread.test.js
//
// Uses node's built-in test runner (node:test). Builds a tiny in-memory
// messages.json fixture, invokes the summarizer as a subprocess, and asserts
// the output contains the expected trace markers.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const SCRIPT = path.join(__dirname, "summarize-thread.js")

function withFixture(messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summarize-thread-test-"))
  fs.writeFileSync(path.join(dir, "messages.json"), JSON.stringify(messages))
  return dir
}

function run(args) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" })
}

test("missing arg prints usage and exits non-zero", () => {
  const res = run([])
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /Usage: summarize-thread\.js/)
})

test("summarizes a basic user+assistant thread", () => {
  const dir = withFixture([
    {
      role: "user",
      parts: [{ type: "text", text: "Build me a demo of foo.com" }],
    },
    {
      role: "assistant",
      metadata: {
        modelId: "anthropic/claude-sonnet-4-6",
        totalUsage: { totalTokens: 1234 },
        cost: 0.0123,
      },
      parts: [
        { type: "text", text: "Starting discovery" },
        {
          type: "tool-terminal",
          state: "output-available",
          input: { command: "agent-browser open https://foo.com" },
          output: { stdout: "ok" },
        },
      ],
    },
  ])
  const res = run([dir])
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.match(res.stdout, /# Thread Trace/)
  assert.match(res.stdout, /Messages: 2 \(user=1, assistant=1\)/)
  assert.match(res.stdout, /Tokens \(sum totalUsage\): 1234/)
  assert.match(res.stdout, /Cost \(sum\): \$0\.0123/)
  assert.match(res.stdout, /USER/)
  assert.match(res.stdout, /ASSISTANT \(claude-sonnet-4-6\) 1234tok/)
  assert.match(res.stdout, /terminal\(agent-browser open/)
})

test("flags errors with ✗ and counts them", () => {
  const dir = withFixture([
    {
      role: "assistant",
      parts: [
        {
          type: "tool-terminal",
          state: "output-available",
          input: { command: "agent-browser find role button --name Submit" },
          output: { stderr: "✗ Ambiguous role match: matched 3 elements" },
        },
      ],
    },
  ])
  const res = run([dir])
  assert.equal(res.status, 0)
  assert.match(res.stdout, /Apparent errors: 1/)
  assert.match(res.stdout, /✗ terminal/)
})

test("--full keeps long output, default truncates", () => {
  const longText = "x".repeat(500)
  const dir = withFixture([
    {
      role: "assistant",
      parts: [{ type: "text", text: longText }],
    },
  ])
  const def = run([dir])
  assert.match(def.stdout, /…\(\+\d+\)/, "default truncates to ~200 with marker")

  const full = run([dir, "--full"])
  assert.doesNotMatch(full.stdout, /…\(\+/, "--full embeds full text")
})

test("accepts a messages.json file path directly", () => {
  const dir = withFixture([{ role: "user", parts: [{ type: "text", text: "hi" }] }])
  const file = path.join(dir, "messages.json")
  const res = run([file])
  assert.equal(res.status, 0)
  assert.match(res.stdout, /Messages: 1/)
})
