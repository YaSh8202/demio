#!/usr/bin/env node
// Smoke test for electron/agent/prompts.ts. Reads the source as text and
// asserts that the auth-flow guidance (B1, B2, C1, C2, C3, C4 from the
// agent-browser-demio-issues backlog) is present.
//
// We treat the prompt as a contract: future edits should not silently drop
// these load-bearing rules.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const PROMPTS = fs.readFileSync(
  path.join(__dirname, "..", "electron", "agent", "prompts.ts"),
  "utf8",
)

test("B1: scene script template includes EXIT trap for record stop", () => {
  assert.match(
    PROMPTS,
    /trap 'agent-browser record stop 2>\/dev\/null \|\| true' EXIT/,
  )
})

test("C1: prompt elevates 'form button[type=submit]' for form submits", () => {
  assert.match(PROMPTS, /form button\[type="submit"\]/)
  // The rule appears at least twice — in the example block and the locator
  // priority list. Catch accidental removal of either.
  const matches = PROMPTS.match(/form button\[type="submit"\]/g) ?? []
  assert.ok(
    matches.length >= 2,
    `expected at least 2 mentions of 'form button[type="submit"]', got ${matches.length}`,
  )
})

test("B2: prompt warns about OAuth-redirect detection", () => {
  assert.match(PROMPTS, /OAuth/)
  assert.match(PROMPTS, /accounts\.google\.com/)
})

test("C2: prompt teaches snapshot @eN ref usage", () => {
  assert.match(PROMPTS, /@eN/)
  assert.match(PROMPTS, /agent-browser snapshot -i/)
})

test("C3: prompt forbids retrying with another role / find nth after ambiguity", () => {
  assert.match(PROMPTS, /DO NOT retry blindly/i)
  assert.match(PROMPTS, /find nth/)
})

test("C4: prompt prefers wait --stable / wait --text over magic numbers", () => {
  assert.match(PROMPTS, /wait --stable/)
  assert.match(PROMPTS, /wait --text/)
})

test("locator-failure-is-not-bad-credentials rule is present", () => {
  // Specific protection against Haiku 4.5's failure mode in thread 0bf676a9.
  assert.match(PROMPTS, /Locator failure ≠ bad credentials/)
})
