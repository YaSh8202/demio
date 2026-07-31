#!/usr/bin/env node
// B3: assert the default model isn't Haiku — observed regressions in
// thread 0bf676a9 where Haiku 4.5 gave up on auth flows after 2-3
// ambiguity errors and incorrectly blamed user credentials.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const TYPES = fs.readFileSync(
  path.join(__dirname, "..", "electron", "agent", "types.ts"),
  "utf8",
)

test("DEFAULT_MODEL_ID is exported", () => {
  assert.match(TYPES, /export const DEFAULT_MODEL_ID\s*=/)
})

test("default model is not Haiku", () => {
  const m = TYPES.match(/export const DEFAULT_MODEL_ID\s*=\s*"([^"]+)"/)
  assert.ok(m, "DEFAULT_MODEL_ID assignment not found")
  const id = m[1]
  assert.doesNotMatch(
    id.toLowerCase(),
    /haiku/,
    `default should not be Haiku (was ${id}) — Haiku 4.5 was observed bailing on auth flows`,
  )
})

test("default model is Sonnet or Opus (durable reasoning)", () => {
  const m = TYPES.match(/export const DEFAULT_MODEL_ID\s*=\s*"([^"]+)"/)
  const id = m[1].toLowerCase()
  assert.ok(
    /(sonnet|opus)/.test(id),
    `default should be Sonnet or Opus (was ${id})`,
  )
})
