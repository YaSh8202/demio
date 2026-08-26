const test = require("node:test")
const assert = require("node:assert")
const { normalizeScript } = require("./replay-pure.cjs")
const {
  buildStepCommands,
  classifyStep,
  expectedDurationMs,
  runScript,
  resolveParams,
} = require("./replay-pure.cjs")

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
  assert.equal(s.actions[0].assert, undefined)
  assert.equal(s.actions[0].narrationAnchor, undefined)
})

test("normalizeScript: preserves explicit values", () => {
  const s = normalizeScript({
    sceneId: "scene-02",
    continuity: "chained",
    oneShot: true,
    startUrl: "https://example.com",
    endUrl: "https://example.com/done",
    actions: [
      { cmd: "click @e1", settleMs: 1500, assert: '--url "https://x"' },
    ],
  })
  assert.equal(s.continuity, "chained")
  assert.equal(s.oneShot, true)
  assert.equal(s.actions[0].settleMs, 1500)
  assert.equal(s.actions[0].assert, '--url "https://x"')
})

test("normalizeScript: rejects a script with no actions", () => {
  assert.throws(
    () =>
      normalizeScript({
        sceneId: "s",
        startUrl: "u",
        endUrl: "u",
        actions: [],
      }),
    /at least one action/
  )
})

test("buildStepCommands: bare action is one command", () => {
  const cmds = buildStepCommands({ cmd: "click @e1", settleMs: 600 })
  assert.deepEqual(cmds, ["click @e1"])
})

test("buildStepCommands: assert becomes a following wait command", () => {
  const cmds = buildStepCommands({
    cmd: "click @e1",
    assert: '--url "https://x/b/"',
    settleMs: 600,
  })
  assert.deepEqual(cmds, ["click @e1", 'wait --url "https://x/b/"'])
})

test("classifyStep: command failure is a deviation", () => {
  const r = classifyStep({
    cmdResult: { ok: false, error: "Element not found" },
    assertResult: null,
  })
  assert.equal(r.status, "deviation")
  assert.match(r.detail, /Element not found/)
})

test("classifyStep: assertion failure is a deviation even when the command succeeded", () => {
  const r = classifyStep({
    cmdResult: { ok: true, output: "" },
    assertResult: { ok: false, error: "timeout waiting for url" },
  })
  assert.equal(r.status, "deviation")
  assert.match(r.detail, /assertion/)
})

test("classifyStep: both clean is ok", () => {
  const r = classifyStep({
    cmdResult: { ok: true, output: "" },
    assertResult: { ok: true, output: "" },
  })
  assert.equal(r.status, "ok")
})

test("expectedDurationMs: sums settle time plus a per-action baseline", () => {
  const script = normalizeScript({
    sceneId: "s",
    startUrl: "u",
    endUrl: "u",
    actions: [
      { cmd: "a", settleMs: 1000 },
      { cmd: "b", settleMs: 2000 },
    ],
  })
  // 3000ms settle + 2 * 400ms baseline = 3800
  assert.equal(expectedDurationMs(script), 3800)
})

test("runScript: every step ok returns ok with one entry per action", async () => {
  const seen = []
  const exec = async (cmds) => {
    seen.push(cmds[0])
    return { ok: true, output: "", exitCode: 0, durationMs: 10 }
  }
  const script = normalizeScript({
    sceneId: "s",
    startUrl: "u",
    endUrl: "u",
    actions: [
      { cmd: "click @e1", settleMs: 0 },
      { cmd: "click @e2", settleMs: 0 },
    ],
  })
  const r = await runScript({ script, exec })
  assert.equal(r.status, "ok")
  assert.equal(r.steps.length, 2)
  assert.deepEqual(seen, ["click @e1", "click @e2"])
})

test("runScript: stops at the first deviation and reports its index", async () => {
  const exec = async (cmds) =>
    cmds[0] === "click @e2"
      ? { ok: false, error: "Element not found", exitCode: 1, durationMs: 5 }
      : { ok: true, output: "", exitCode: 0, durationMs: 5 }
  const script = normalizeScript({
    sceneId: "s",
    startUrl: "u",
    endUrl: "u",
    actions: [
      { cmd: "click @e1", settleMs: 0 },
      { cmd: "click @e2", settleMs: 0 },
      { cmd: "click @e3", settleMs: 0 },
    ],
  })
  const r = await runScript({ script, exec })
  assert.equal(r.status, "deviation")
  assert.equal(r.deviation.index, 1)
  assert.equal(r.deviation.cmd, "click @e2")
  // step 3 must not have run
  assert.equal(r.steps.length, 2)
})

test("runScript: an aborted signal stops before the next step", async () => {
  const controller = new AbortController()
  const exec = async () => {
    controller.abort()
    return { ok: true, output: "", exitCode: 0, durationMs: 1 }
  }
  const script = normalizeScript({
    sceneId: "s",
    startUrl: "u",
    endUrl: "u",
    actions: [
      { cmd: "a", settleMs: 0 },
      { cmd: "b", settleMs: 0 },
    ],
  })
  const r = await runScript({ script, exec, signal: controller.signal })
  assert.equal(r.steps.length, 1)
  assert.equal(r.status, "aborted")
})

const { recordingBracket } = require("./replay-pure.cjs")

test("recordingBracket: independent scene opens the start URL then starts", () => {
  const script = normalizeScript({
    sceneId: "scene-01",
    continuity: "independent",
    startUrl: "https://example.com/boards",
    endUrl: "https://example.com/b/1",
    actions: [{ cmd: "click @e1" }],
  })
  const b = recordingBracket({
    script,
    videoPath: "/w/scenes/scene-01.webm",
    actionsPath: "/w/scenes/scene-01.actions.jsonl",
    isRetry: false,
  })
  assert.equal(b.resetsPage, true)
  assert.equal(b.commands.length, 2)
  assert.match(b.commands[0], /^open /)
  assert.match(b.commands[1], /^record start /)
  assert.match(b.commands[1], /--log-actions/)
})

test("recordingBracket: chained scene restarts without navigating", () => {
  const script = normalizeScript({
    sceneId: "scene-02",
    continuity: "chained",
    startUrl: "https://example.com/b/1",
    endUrl: "https://example.com/b/1",
    actions: [{ cmd: "click @e1" }],
  })
  const b = recordingBracket({
    script,
    videoPath: "/w/scenes/scene-02.webm",
    actionsPath: "/w/scenes/scene-02.actions.jsonl",
    isRetry: false,
  })
  assert.equal(b.resetsPage, false)
  assert.equal(b.commands.length, 1)
  assert.match(b.commands[0], /^record restart /)
  assert.match(b.commands[0], /--log-actions/)
})

test("recordingBracket: a chained scene falls back to open+start on retry", () => {
  const script = normalizeScript({
    sceneId: "scene-02",
    continuity: "chained",
    startUrl: "https://example.com/b/1",
    endUrl: "https://example.com/b/1",
    actions: [{ cmd: "click @e1" }],
  })
  const b = recordingBracket({
    script,
    videoPath: "/w/scenes/scene-02.webm",
    actionsPath: "/w/scenes/scene-02.actions.jsonl",
    isRetry: true,
  })
  assert.equal(b.resetsPage, true)
  assert.equal(b.commands.length, 2)
  assert.match(b.commands[0], /^open /)
})

test("recordingBracket: quotes paths containing spaces", () => {
  const script = normalizeScript({
    sceneId: "scene-03",
    startUrl: "https://example.com",
    endUrl: "https://example.com",
    actions: [{ cmd: "click @e1" }],
  })
  const b = recordingBracket({
    script,
    videoPath: "/my workspace/scenes/scene-03.webm",
    actionsPath: "/my workspace/scenes/scene-03.actions.jsonl",
    isRetry: false,
  })
  assert.match(b.commands[1], /'\/my workspace\/scenes\/scene-03\.webm'/)
})

test("resolveParams: substitutes in cmd and assert", () => {
  const out = resolveParams({
    sceneId: "scene-01",
    continuity: "independent",
    oneShot: false,
    startUrl: "https://example.com",
    endUrl: "https://example.com/b",
    params: { boardName: "Demio QA" },
    actions: [
      {
        cmd: 'find role textbox --name "Board title" fill "{{boardName}}"',
        assert: '--text "{{boardName}}"',
        settleMs: 400,
      },
    ],
  })
  assert.equal(
    out.actions[0].cmd,
    'find role textbox --name "Board title" fill "Demio QA"'
  )
  assert.equal(out.actions[0].assert, '--text "Demio QA"')
})

test("resolveParams: a script with no placeholders is returned unchanged", () => {
  const script = {
    sceneId: "scene-01",
    continuity: "independent",
    oneShot: false,
    startUrl: "https://example.com",
    endUrl: "https://example.com/b",
    params: {},
    actions: [{ cmd: "click @e1", settleMs: 600 }],
  }
  const out = resolveParams(script)
  assert.equal(out.actions[0].cmd, "click @e1")
  assert.equal(out.actions[0].assert, undefined)
})

test("resolveParams: an unresolved placeholder throws, naming scene, index and key", () => {
  assert.throws(
    () =>
      resolveParams({
        sceneId: "scene-07",
        continuity: "independent",
        oneShot: false,
        startUrl: "u",
        endUrl: "u",
        params: { other: "x" },
        actions: [{ cmd: "type {{boardName}}", settleMs: 600 }],
      }),
    /scene-07.*action 0.*boardName/
  )
})

test("resolveParams: a value containing braces is not re-expanded", () => {
  const out = resolveParams({
    sceneId: "scene-01",
    continuity: "independent",
    oneShot: false,
    startUrl: "u",
    endUrl: "u",
    params: { a: "{{b}}", b: "SHOULD NOT APPEAR" },
    actions: [{ cmd: "type {{a}}", settleMs: 600 }],
  })
  assert.equal(out.actions[0].cmd, "type {{b}}")
})

test("normalizeScript: params default to an empty object", () => {
  const s = normalizeScript({
    sceneId: "scene-01",
    startUrl: "https://example.com",
    endUrl: "https://example.com/done",
    actions: [{ cmd: "click @e1" }],
  })
  assert.deepEqual(s.params, {})
})
