const test = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const {
  lintScript,
  formatFindings,
  checkReplayDuration,
} = require("./script-lint-pure.cjs")
const { normalizeScript, expectedDurationMs } = require("./replay-pure.cjs")
const { checkComputedDuration } = require("./artifact-pure.cjs")

const base = (over) =>
  normalizeScript({
    sceneId: "flow.01",
    startUrl: "https://x.test/",
    endUrl: "https://x.test/done",
    actions: [{ cmd: 'click "#go"', assert: '--url "https://x.test/done"' }],
    ...over,
  })

const rules = (s) => lintScript(s).findings.map((f) => f.rule)

test("lint: a clean script has no findings", () => {
  assert.deepEqual(lintScript(base()), { ok: true, findings: [] })
})

test("lint: stale-ref on cmd, waitBefore and assert", () => {
  const s = base({
    actions: [
      { cmd: "click @e12", waitBefore: "--selector @e3", assert: "--text @e4" },
    ],
  })
  assert.deepEqual(rules(s), ["stale-ref", "stale-ref", "stale-ref"])
})

test("lint: leading open is positioning's job", () => {
  const s = base({
    actions: [{ cmd: "open https://x.test/" }, { cmd: "click a" }],
  })
  assert.deepEqual(rules(s), ["leading-open"])
})

test("lint: leading wait --load is the electron-chromium-talk.01 failure", () => {
  const s = base({
    actions: [{ cmd: "wait --load complete", waitBefore: '--text "Electron"' }],
  })
  const r = rules(s)
  assert.ok(r.includes("leading-load-wait"), r.join())
  assert.ok(r.includes("unknown-load-state"), r.join())
})

test("lint: a load wait in the first waitBefore is the same dead air", () => {
  const s = base({ actions: [{ cmd: 'click "a"', waitBefore: "--load load" }] })
  assert.deepEqual(rules(s), ["leading-load-wait"])
})

test("lint: a load wait AFTER a navigating step is allowed", () => {
  const s = base({
    actions: [
      { cmd: 'click "a.next"', waitBefore: '--text "Next"' },
      { cmd: "wait --load load", assert: '--url "https://x.test/done"' },
    ],
  })
  assert.deepEqual(rules(s), [])
})

test("lint: only real agent-browser load states pass", () => {
  for (const state of ["load", "domcontentloaded", "networkidle", "none"]) {
    const s = base({
      actions: [{ cmd: 'click "a"' }, { cmd: `wait --load ${state}` }],
    })
    assert.deepEqual(rules(s), [], state)
  }
  const bad = base({
    actions: [{ cmd: 'click "a"' }, { cmd: "wait -l complete" }],
  })
  assert.deepEqual(rules(bad), ["unknown-load-state"])
})

test("lint: password-fill", () => {
  const s = base({
    actions: [{ cmd: 'fill "input[type=password]" "hunter2"' }],
  })
  assert.deepEqual(rules(s), ["password-fill"])
})

test("lint: params must be bound and used", () => {
  const unbound = base({ actions: [{ cmd: 'fill "#name" "{{boardName}}"' }] })
  assert.deepEqual(rules(unbound), ["unbound-param"])
  // Advisory: an unused param is the normal state mid-rehearsal.
  const unused = lintScript(base({ params: { boardName: "Q3 plan" } }))
  assert.equal(unused.ok, true)
  assert.deepEqual(
    unused.findings.map((f) => [f.rule, f.blocking]),
    [["unused-param", false]]
  )
  const good = base({
    params: { boardName: "Q3 plan" },
    actions: [{ cmd: 'fill "#name" "{{boardName}}"' }],
  })
  assert.deepEqual(rules(good), [])
})

test("lint: formatFindings is one line per finding with rule and index", () => {
  const s = base({ actions: [{ cmd: "click @e1" }] })
  const text = formatFindings(lintScript(s).findings)
  assert.match(text, /^\[stale-ref @0\] /)
})

// ── checkReplayDuration ──────────────────────────────────────────────────────

test("duration: predicted = step time + settles, band shared with verify", () => {
  const s = base({
    actions: [
      { cmd: 'click "#a"', settleMs: 500 },
      { cmd: 'click "#b"', settleMs: 500 },
    ],
  })
  const steps = [
    { index: 0, cmd: 'click "#a"', durationMs: 300 },
    { index: 1, cmd: 'click "#b"', durationMs: 400 },
  ]
  const r = checkReplayDuration(s, steps)
  assert.equal(r.predictedMs, 1700)
  assert.equal(r.expectedMs, expectedDurationMs(s))
  assert.equal(r.ok, true)
  // The invariant: this is verify.ts's band, not a second one.
  const v = checkComputedDuration(r.predictedMs / 1000, r.expectedMs / 1000)
  assert.equal(r.ok, v.ok)
})

test("duration: a 25s step on a 1.8s script fails and is named", () => {
  const s = base({
    actions: [
      { cmd: "wait --load complete", waitBefore: '--text "E"', settleMs: 1000 },
    ],
  })
  const r = checkReplayDuration(s, [
    { index: 0, cmd: "wait --load complete", durationMs: 25_494 },
  ])
  assert.equal(r.ok, false)
  assert.deepEqual(r.slowest, {
    index: 0,
    cmd: "wait --load complete",
    durationMs: 25_494,
  })
  assert.match(
    r.detail,
    /slowest step 0 \(`wait --load complete`\) took 25\.5s/
  )
})

test("duration: too FAST fails too (search-wikipedia.01 mirror case)", () => {
  const s = base({
    actions: [
      { cmd: 'fill "#q" "x"', settleMs: 1000 },
      { cmd: 'click "#r"', settleMs: 1000 },
      { cmd: "scroll down 300", settleMs: 1000 },
    ],
  })
  // Expected ≈ 4.2s; a 0.5s replay is outside [2.1, 11.3].
  const r = checkReplayDuration(s, [
    { index: 0, cmd: 'fill "#q" "x"', durationMs: 100 },
    { index: 1, cmd: 'click "#r"', durationMs: 100 },
    { index: 2, cmd: "scroll down 300", durationMs: 100 },
  ])
  // 300 + 3000 settles = 3.3s: inside the band. The real failure recorded
  // 0.5s because the settles never happened on camera — the point of this
  // test is that predicted includes settles and the band is verify's.
  assert.equal(r.predictedMs, 3300)
  assert.equal(r.ok, true)
  const fast = checkReplayDuration(
    { ...s, actions: s.actions.map((a) => ({ ...a, settleMs: 0 })) },
    [{ index: 0, cmd: "x", durationMs: 100 }]
  )
  assert.equal(fast.ok, false)
})

// ── fixtures: real scripts, findings pinned ─────────────────────────────────

const fixturesDir = path.join(__dirname, "fixtures", "scripts")
const fixtures = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [
    f.replace(/\.json$/, ""),
    JSON.parse(fs.readFileSync(path.join(fixturesDir, f), "utf8")),
  ])

// Every real script the rehearsal agent wrote, and what the linter says
// about it. An entry here is a claim: adding a rule that changes one of
// these is a deliberate decision, not a side effect.
const PINNED = {
  "b041e55a/electron-chromium-talk.01": [
    "leading-load-wait",
    "unknown-load-state",
  ],
}

for (const [ws, doc] of fixtures) {
  for (const raw of doc.scripts) {
    const key = `${ws}/${raw.sceneId}`
    test(`fixture ${key}`, () => {
      const r = rules(normalizeScript(raw))
      assert.deepEqual(
        r.sort(),
        (PINNED[key] ?? []).sort(),
        formatFindings(lintScript(raw).findings)
      )
    })
  }
}

test("fixtures: no credential-shaped literal survived redaction", () => {
  for (const [, doc] of fixtures) {
    for (const s of doc.scripts) {
      for (const a of s.actions) {
        const m = /^(fill|type)\s+(?:".*?"|\S+)\s+"(.*)"$/.exec(a.cmd)
        if (m) assert.ok(/^(<redacted>|\{\{.*\}\})$/.test(m[2]), a.cmd)
      }
    }
  }
})

// ── checkAmendment ───────────────────────────────────────────────────────────

const { checkAmendment } = require("./script-lint-pure.cjs")
const orig = [
  {
    cmd: 'click "#new"',
    waitBefore: '--text "Boards"',
    assert: '--url "/new"',
    settleMs: 600,
  },
  { cmd: 'fill "#name" "Q3"', assert: '--text "Q3"', settleMs: 600 },
]

test("amendment: replacing only the failing step, assertion kept, is ok", () => {
  const r = checkAmendment(
    orig,
    [
      {
        cmd: 'find role button --name "New" click',
        waitBefore: '--text "New"',
        assert: '--url "/new"',
      },
      orig[1],
    ],
    0
  )
  assert.equal(r.ok, true, r.detail)
})

test("amendment: the failing step may become several steps", () => {
  const r = checkAmendment(
    orig,
    [
      { cmd: 'wait --selector "#nav"' },
      { cmd: 'click "#new2"', assert: '--url "/new"' },
      orig[1],
    ],
    0
  )
  assert.equal(r.ok, true, r.detail)
})

test("amendment: touching another step is rejected, naming it", () => {
  const r = checkAmendment(
    orig,
    [{ ...orig[0], cmd: 'click "#new2"' }, { cmd: 'fill "#name" "Q3"' }],
    0
  )
  assert.equal(r.ok, false)
  assert.match(
    r.detail,
    /step 1 .*was changed but step 0 is the one that failed/
  )
})

test("amendment: settleMs default is applied before comparing", () => {
  const r = checkAmendment(
    orig,
    [
      { cmd: 'click "#new2"', assert: '--url "/new"' },
      { cmd: 'fill "#name" "Q3"', assert: '--text "Q3"' },
    ],
    0
  )
  // step 1 omits settleMs; the schema default (600) makes it identical.
  assert.equal(r.ok, true, r.detail)
})

test("amendment: dropping the failing step's assertion is rejected", () => {
  const r = checkAmendment(orig, [{ cmd: 'click "#new2"' }, orig[1]], 0)
  assert.equal(r.ok, false)
  assert.match(r.detail, /asserted .* and its replacement asserts nothing/)
})

test("amendment: deleting the failing step is rejected", () => {
  const r = checkAmendment(orig, [orig[1]], 0)
  assert.equal(r.ok, false)
  assert.match(r.detail, /fewer than the 2/)
})
