const test = require("node:test")
const assert = require("node:assert")
const {
  emptyScripts,
  mergeScript,
  dropFlowScripts,
  emptyCheckpoint,
  beginFlow,
  finishFlow,
  inProgressFlow,
  appendFinding,
} = require("./rehearsal-pure.cjs")

const script = (sceneId) => ({
  sceneId,
  continuity: "independent",
  oneShot: false,
  startUrl: "https://example.com",
  endUrl: "https://example.com/done",
  params: {},
  actions: [{ cmd: "click @e1", settleMs: 600 }],
})

test("mergeScript: appends a new scene", () => {
  const doc = mergeScript(emptyScripts(), script("scene-01"))
  assert.equal(doc.version, 1)
  assert.deepEqual(
    doc.scripts.map((s) => s.sceneId),
    ["scene-01"]
  )
})

test("mergeScript: replaces an existing scene in place, preserving order", () => {
  let doc = emptyScripts()
  doc = mergeScript(doc, script("scene-01"))
  doc = mergeScript(doc, script("scene-02"))
  const revised = { ...script("scene-01"), endUrl: "https://example.com/v2" }
  doc = mergeScript(doc, revised)
  assert.deepEqual(
    doc.scripts.map((s) => s.sceneId),
    ["scene-01", "scene-02"]
  )
  assert.equal(doc.scripts[0].endUrl, "https://example.com/v2")
})

test("mergeScript: does not mutate the input document", () => {
  const before = mergeScript(emptyScripts(), script("scene-01"))
  const snapshot = JSON.stringify(before)
  mergeScript(before, script("scene-02"))
  assert.equal(JSON.stringify(before), snapshot)
})

test("dropFlowScripts: removes only that flow's scenes", () => {
  let doc = emptyScripts()
  doc = mergeScript(doc, script("create-board.01"))
  doc = mergeScript(doc, script("create-board.02"))
  doc = mergeScript(doc, script("invite-teammate.01"))
  const out = dropFlowScripts(doc, "create-board")
  assert.deepEqual(
    out.scripts.map((s) => s.sceneId),
    ["invite-teammate.01"]
  )
})

test("dropFlowScripts: a flow id that prefixes another does not delete it", () => {
  let doc = emptyScripts()
  doc = mergeScript(doc, script("create-board.01"))
  doc = mergeScript(doc, script("create-board-list.01"))
  const out = dropFlowScripts(doc, "create-board")
  assert.deepEqual(
    out.scripts.map((s) => s.sceneId),
    ["create-board-list.01"]
  )
})

test("beginFlow: records the in-progress flow and its start URL", () => {
  const doc = beginFlow(emptyCheckpoint(), {
    id: "flow-01",
    label: "Create a board",
    startUrl: "https://app.x.com/boards",
  })
  const flow = inProgressFlow(doc)
  assert.equal(flow.id, "flow-01")
  assert.equal(flow.startUrl, "https://app.x.com/boards")
  assert.equal(flow.status, "in-progress")
})

test("beginFlow: re-beginning the same flow updates it rather than duplicating", () => {
  let doc = beginFlow(emptyCheckpoint(), {
    id: "flow-01",
    label: "Create a board",
    startUrl: "https://app.x.com/boards",
  })
  doc = beginFlow(doc, {
    id: "flow-01",
    label: "Create a board",
    startUrl: "https://app.x.com/boards?v=2",
  })
  assert.equal(doc.flows.length, 1)
  assert.equal(doc.flows[0].startUrl, "https://app.x.com/boards?v=2")
})

test("finishFlow: marks done and records the scenes it produced", () => {
  let doc = beginFlow(emptyCheckpoint(), {
    id: "flow-01",
    label: "Create a board",
    startUrl: "https://app.x.com/boards",
  })
  doc = finishFlow(doc, {
    id: "flow-01",
    status: "done",
    sceneIds: ["scene-01", "scene-02"],
    detail: "",
  })
  assert.equal(doc.flows[0].status, "done")
  assert.deepEqual(doc.flows[0].sceneIds, ["scene-01", "scene-02"])
  assert.equal(inProgressFlow(doc), null)
})

test("finishFlow: a blocked flow keeps its reason and is not in progress", () => {
  let doc = beginFlow(emptyCheckpoint(), {
    id: "flow-02",
    label: "Invite a teammate",
    startUrl: "https://app.x.com/settings",
  })
  doc = finishFlow(doc, {
    id: "flow-02",
    status: "blocked",
    sceneIds: [],
    detail: "needs a second seat on the plan",
  })
  assert.equal(doc.flows[0].status, "blocked")
  assert.match(doc.flows[0].detail, /second seat/)
  assert.equal(inProgressFlow(doc), null)
})

test("finishFlow: an unknown flow id throws rather than inventing an entry", () => {
  assert.throws(
    () =>
      finishFlow(emptyCheckpoint(), {
        id: "flow-99",
        status: "done",
        sceneIds: [],
        detail: "",
      }),
    /flow-99/
  )
})

test("appendFinding: creates the file body and the flow's section", () => {
  const md = appendFinding("", {
    flowId: "flow-01",
    kind: "selector",
    text: 'two "Create" buttons; used role button --name "Create board" --exact',
  })
  assert.match(md, /^# Rehearsal findings/)
  assert.match(md, /## flow-01/)
  assert.match(md, /- \*\*selector:\*\* two "Create" buttons/)
})

test("appendFinding: a second finding for the same flow reuses the section", () => {
  let md = appendFinding("", {
    flowId: "flow-01",
    kind: "selector",
    text: "first",
  })
  md = appendFinding(md, { flowId: "flow-01", kind: "wait", text: "second" })
  assert.equal(md.match(/## flow-01/g).length, 1)
  assert.ok(md.indexOf("first") < md.indexOf("second"))
})

test("appendFinding: a new flow gets its own section at the end", () => {
  let md = appendFinding("", { flowId: "flow-01", kind: "note", text: "a" })
  md = appendFinding(md, { flowId: "flow-02", kind: "note", text: "b" })
  assert.ok(md.indexOf("## flow-01") < md.indexOf("## flow-02"))
})

test("appendFinding: an earlier flow's finding lands in its own section, not the last one", () => {
  let md = appendFinding("", { flowId: "flow-01", kind: "note", text: "a" })
  md = appendFinding(md, { flowId: "flow-02", kind: "note", text: "b" })
  md = appendFinding(md, {
    flowId: "flow-01",
    kind: "state-created",
    text: "board Demio QA",
  })
  assert.ok(md.indexOf("board Demio QA") < md.indexOf("## flow-02"))
})

test("appendFinding: an unknown kind throws", () => {
  assert.throws(
    () => appendFinding("", { flowId: "f", kind: "vibes", text: "x" }),
    /vibes/
  )
})
