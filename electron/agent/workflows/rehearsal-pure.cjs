// Pure rehearsal-artifact logic. CommonJS so `node --test` runs it with zero
// build step (same pattern as replay-pure.cjs / verify-pure.cjs / edl-pure.cjs).
// No I/O — rehearsal.ts owns every read and write.
//
// Every function here is non-mutating: it returns a new document. The store
// reads a file, calls one of these, and writes the result back, so an
// accidental in-place edit would silently skip the write.
"use strict"

const REHEARSAL_VERSION = 1

// ── scripts ─────────────────────────────────────────────────────────────────

function emptyScripts() {
  return { version: REHEARSAL_VERSION, scripts: [] }
}

/**
 * Add one proven scene script, replacing any earlier entry for the same
 * sceneId **in place** so scene order stays the order rehearsal proved them
 * in — that order is what `toScenesStep` and the concat rely on.
 *
 * Called once per proven scene, never batched: Observational Memory (if it is
 * ever enabled) summarises, and a summary destroys an exact locator. The
 * files hold precision; the conversation holds understanding. See spec §9.
 */
function mergeScript(doc, script) {
  const scripts = doc.scripts.slice()
  const at = scripts.findIndex((s) => s.sceneId === script.sceneId)
  if (at === -1) scripts.push(script)
  else scripts[at] = script
  return { version: REHEARSAL_VERSION, scripts }
}

/**
 * Remove every script belonging to one flow.
 *
 * Called before a flow is re-rehearsed (a resumed run, or a revision after
 * Gate B): the second attempt may produce FEWER scenes than the first, and
 * `mergeScript` alone would leave the extra ones behind as orphans that
 * `toScenesStep` would happily record.
 *
 * The `.` separator is what makes this safe: scene ids are `<flowId>.NN` and
 * a flow id is kebab-case, so `create-board.` cannot prefix-match
 * `create-board-list.01`.
 */
function dropFlowScripts(doc, flowId) {
  const prefix = `${flowId}.`
  return {
    version: REHEARSAL_VERSION,
    scripts: doc.scripts.filter((s) => !s.sceneId.startsWith(prefix)),
  }
}

// ── checkpoint ──────────────────────────────────────────────────────────────

function emptyCheckpoint() {
  return { version: REHEARSAL_VERSION, flows: [] }
}

/**
 * Mark a flow as the one currently being rehearsed.
 *
 * `startUrl` is the load-bearing field: on an app restart the browser is
 * guaranteed gone (`cleanupStaleSessions()` runs `close --all` at app start,
 * daemon.ts:18-32), so resuming means re-opening exactly this URL and
 * replaying the flow from its start. Recording only which flows are *done*
 * would leave nowhere to rewind to. See spec §10.
 */
function beginFlow(doc, { id, label, startUrl }) {
  const flows = doc.flows.slice()
  const entry = {
    id,
    label,
    startUrl,
    status: "in-progress",
    sceneIds: [],
    detail: "",
  }
  const at = flows.findIndex((f) => f.id === id)
  if (at === -1) flows.push(entry)
  else flows[at] = { ...flows[at], ...entry }
  return { version: REHEARSAL_VERSION, flows }
}

function finishFlow(doc, { id, status, sceneIds, detail }) {
  const flows = doc.flows.slice()
  const at = flows.findIndex((f) => f.id === id)
  if (at === -1) {
    // Never invent an entry: a finish with no matching begin means the caller
    // lost track of the flow, and silently appending would hide that while
    // producing a checkpoint with no startUrl to rewind to.
    throw new Error(`finishFlow: no flow "${id}" was ever begun`)
  }
  flows[at] = { ...flows[at], status, sceneIds, detail }
  return { version: REHEARSAL_VERSION, flows }
}

/** The flow to rewind to on resume, or null when rehearsal is between flows. */
function inProgressFlow(doc) {
  return doc.flows.find((f) => f.status === "in-progress") || null
}

// ── findings ────────────────────────────────────────────────────────────────

/**
 * Closed set on purpose. Gate B has to be able to find the blockers and the
 * state rehearsal left behind (spec §11.2) without reading prose, and a free
 * text kind would make that a search problem.
 */
const FINDING_KINDS = ["selector", "wait", "blocker", "state-created", "note"]

const FINDINGS_TITLE = "# Rehearsal findings"

/**
 * Append one finding under its flow's section, creating the section (and the
 * document) when needed. Returns the new markdown.
 *
 * A finding for an EARLIER flow lands in that flow's section rather than at
 * the end of the file — rehearsal often learns something about flow 1 while
 * walking flow 3 ("this is the banner that blocked us earlier").
 */
function appendFinding(markdown, { flowId, kind, text }) {
  if (!FINDING_KINDS.includes(kind)) {
    throw new Error(
      `appendFinding: unknown kind "${kind}" — expected one of ${FINDING_KINDS.join(", ")}`
    )
  }
  const bullet = `- **${kind}:** ${text}`
  const heading = `## ${flowId}`
  const base =
    markdown && markdown.trim() ? markdown.replace(/\s+$/, "") : FINDINGS_TITLE
  const lines = base.split("\n")
  const at = lines.indexOf(heading)
  if (at === -1) {
    return [...lines, "", heading, "", bullet, ""].join("\n")
  }
  // End of this section = the next `## ` heading, or end of file.
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i
      break
    }
  }
  // Insert before the section's trailing blank lines, so the blank separating
  // this section from the next one survives.
  let insert = end
  while (insert > at + 1 && lines[insert - 1].trim() === "") insert--
  return [...lines.slice(0, insert), bullet, ...lines.slice(insert)].join("\n")
}

module.exports = {
  REHEARSAL_VERSION,
  emptyScripts,
  mergeScript,
  dropFlowScripts,
  emptyCheckpoint,
  beginFlow,
  finishFlow,
  inProgressFlow,
  FINDING_KINDS,
  appendFinding,
}
