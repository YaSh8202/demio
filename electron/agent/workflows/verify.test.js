const test = require("node:test")
const assert = require("node:assert")
const { parseActionsLog } = require("./verify-pure.cjs")

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
    JSON.stringify({
      tsMs: 500,
      action: "click",
      target: "@e9",
      ok: false,
      error: "not found",
    }),
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
