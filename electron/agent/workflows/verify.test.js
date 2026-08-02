const test = require("node:test")
const assert = require("node:assert")
const {
  parseActionsLog,
  checkDurationRange,
  checkEndUrl,
} = require("./verify-pure.cjs")

test("parseActionsLog: all ok", () => {
  const jsonl = [
    JSON.stringify({ tsMs: 0, action: "click", target: "@e1", ok: true }),
    JSON.stringify({ tsMs: 900, action: "type", target: "@e2", ok: true }),
  ].join("\n")
  const r = parseActionsLog(jsonl)
  assert.equal(r.total, 2)
  assert.equal(r.failed.length, 0)
})

test("parseActionsLog: reports failed line with action and error", () => {
  const jsonl = [
    JSON.stringify({ tsMs: 0, action: "click", target: "@e1", ok: true }),
    JSON.stringify({ tsMs: 500, action: "click", target: "@e9", ok: false, error: "not found" }),
  ].join("\n")
  const r = parseActionsLog(jsonl)
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].line, 2)
  assert.match(r.failed[0].error, /not found/)
})

test("parseActionsLog: tolerates blank lines and bad JSON as failures", () => {
  const r = parseActionsLog('{"ok":true,"action":"click","tsMs":0}\n\nnot-json')
  assert.equal(r.total, 2)
  assert.equal(r.failed.length, 1)
})

test("checkDurationRange: inside range passes", () => {
  const scene = { minDurationSec: 4, maxDurationSec: 90 }
  assert.equal(checkDurationRange(30, scene).ok, true)
})

test("checkDurationRange: too short fails with detail", () => {
  const scene = { minDurationSec: 4, maxDurationSec: 90 }
  const r = checkDurationRange(1.2, scene)
  assert.equal(r.ok, false)
  assert.match(r.detail, /1.2/)
})

test("checkEndUrl: prefix match ignoring trailing slash and hash", () => {
  const scene = { endUrl: "https://trello.com/b/abc" }
  assert.equal(checkEndUrl("https://trello.com/b/abc/demio-qa#card-3", scene).ok, true)
  assert.equal(checkEndUrl("https://trello.com/login", scene).ok, false)
})
