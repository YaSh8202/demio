const test = require("node:test")
const assert = require("node:assert")
const { normalizeScript } = require("./replay-pure.cjs")

test("normalizeScript: applies settleMs and continuity defaults", () => {
  const s = normalizeScript({
    sceneId: "scene-01",
    startUrl: "https://example.com",
    endUrl: "https://example.com/done",
    actions: [{ cmd: "click @e1" }],
  })
  assert.equal(s.continuity, "independent")
  assert.equal(s.oneShot, false)
  assert.equal(s.actions[0].settleMs, 600)
})

test("normalizeScript: preserves explicit values", () => {
  const s = normalizeScript({
    sceneId: "scene-02",
    continuity: "chained",
    oneShot: true,
    startUrl: "https://example.com",
    endUrl: "https://example.com/done",
    actions: [{ cmd: "click @e1", settleMs: 1500, assert: '--url "https://x"' }],
  })
  assert.equal(s.continuity, "chained")
  assert.equal(s.oneShot, true)
  assert.equal(s.actions[0].settleMs, 1500)
  assert.equal(s.actions[0].assert, '--url "https://x"')
})

test("normalizeScript: rejects a script with no actions", () => {
  assert.throws(
    () => normalizeScript({ sceneId: "s", startUrl: "u", endUrl: "u", actions: [] }),
    /at least one action/
  )
})
