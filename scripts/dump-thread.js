#!/usr/bin/env node
// Dump the complete chat history of a demio thread.
//
// The file store's messages.json has been empty since ADR-007 moved the
// conversation into the AgentController's own storage (~/.demio/mastra.db);
// `apis.agent.listMessages` reads it via `session.thread.listActiveMessages`.
// This script reads the same rows straight off disk.
//
// Usage:
//   node scripts/dump-thread.js                  # list every thread
//   node scripts/dump-thread.js <threadId>       # dump one (id prefix is enough)
//   node scripts/dump-thread.js <threadId> --full   # untruncated text/outputs
//   node scripts/dump-thread.js <threadId> --json   # raw message rows
//   node scripts/dump-thread.js <threadId> --data   # keep data-* stream parts
//   node scripts/dump-thread.js <threadId> --agents # recorder/narrator transcripts
//
// --agents reads the workflow sub-agents' conversations. Those agents run as
// bare `agent.generate()` calls with no memory/threadId, so they never reach
// mastra_messages; `workflows/record-scene.ts` writes each attempt to
// `<workspace>/scenes/<sceneId>.attempt-N.agent.json` and the narrator step
// writes `<workspace>/narration.agent.json`. Runs from before those writes
// existed have no transcript to show.

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createClient } = require("@libsql/client")

// DEMIO_HOME: the same override the app honours (store/paths.ts) — a smoke
// run's threads live under ~/.demio-smoke, not here.
const ROOT = process.env.DEMIO_HOME || path.join(os.homedir(), ".demio")
const args = process.argv.slice(2)
const full = args.includes("--full")
const asJson = args.includes("--json")
// `data-*` parts are UI stream plumbing (workspace metadata, sandbox exit
// codes) — one per tool call, and they bury the actual conversation.
const showData = args.includes("--data")
const showAgents = args.includes("--agents")
const wanted = args.find((a) => !a.startsWith("--"))

const TRUNC = full ? 100000 : 300
const trunc = (s, n = TRUNC) => {
  if (s == null) return ""
  s = typeof s === "string" ? s : JSON.stringify(s)
  s = s.replace(/\s+/g, " ").trim()
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s
}

// mastra_threads.metadata is a msgpack blob; the two UUIDs we need appear in
// it as plain text right after their keys. Cheaper than pulling in a decoder.
function idsFromMetadata(meta) {
  const s = Buffer.isBuffer(meta)
    ? meta.toString("latin1")
    : typeof meta === "string"
      ? meta
      : Buffer.from(meta ?? []).toString("latin1")
  const uuid = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
  return {
    projectId: (s.match(new RegExp("projectId.{0,3}" + uuid)) || [])[1] ?? null,
    threadId: (s.match(new RegExp("threadId.{0,3}" + uuid)) || [])[1] ?? null,
    modelId: (s.match(/currentModeId.{0,3}(\w+)/) || [])[1] ?? null,
  }
}

function fileMeta(projectId, threadId) {
  try {
    const p = path.join(
      ROOT,
      "projects",
      projectId,
      "threads",
      threadId,
      "meta.json"
    )
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return {}
  }
}

async function main() {
  const db = createClient({ url: "file:" + path.join(ROOT, "mastra.db") })

  const threads = (
    await db.execute(
      "select id, metadata, createdAt from mastra_threads order by createdAt desc"
    )
  ).rows
  const counts = new Map()
  for (const r of (
    await db.execute(
      "select thread_id, count(*) c, sum(length(content)) b from mastra_messages group by 1"
    )
  ).rows) {
    counts.set(r.thread_id, { c: Number(r.c), b: Number(r.b) })
  }

  const rows = threads.map((t) => {
    const ids = idsFromMetadata(t.metadata)
    const fm =
      ids.projectId && ids.threadId ? fileMeta(ids.projectId, ids.threadId) : {}
    const stat = counts.get(t.id) || { c: 0, b: 0 }
    return {
      mastraId: t.id,
      ...ids,
      createdAt: t.createdAt,
      title: fm.title || "(untitled)",
      domain: fm.domain || "-",
      ...stat,
    }
  })

  if (!wanted) {
    console.log(
      "thread id (use with this script)          msgs    KB  domain                title"
    )
    console.log("-".repeat(100))
    for (const r of rows) {
      const id = r.threadId || r.mastraId + " (unmapped)"
      console.log(
        `${id}  ${String(r.c).padStart(4)}  ${String(Math.round(r.b / 1024)).padStart(4)}  ${(r.domain || "-").padEnd(20).slice(0, 20)}  ${r.title}`
      )
    }
    console.log(
      "\nDump one:  node scripts/dump-thread.js <thread id> [--full|--json]"
    )
    return
  }

  const hit = rows.find(
    (r) =>
      (r.threadId || "").startsWith(wanted) || r.mastraId.startsWith(wanted)
  )
  if (!hit) {
    console.error(
      `No thread matching "${wanted}". Run without arguments to list them.`
    )
    process.exit(1)
  }

  const msgs = (
    await db.execute({
      sql: "select id, role, type, content, createdAt from mastra_messages where thread_id = ? order by createdAt asc",
      args: [hit.mastraId],
    })
  ).rows

  if (asJson) {
    console.log(
      JSON.stringify(
        msgs.map((m) => ({ ...m, content: JSON.parse(m.content) })),
        null,
        2
      )
    )
    return
  }

  console.log(`# ${hit.title}`)
  console.log(`thread   ${hit.threadId}  (controller thread ${hit.mastraId})`)
  console.log(`project  ${hit.projectId}`)
  console.log(`domain   ${hit.domain}`)
  console.log(
    `rows     ${msgs.length} messages, ${Math.round(msgs.reduce((n, m) => n + m.content.length, 0) / 1024)} KB`
  )
  const ws = path.join(ROOT, "workspaces", hit.threadId || "")
  console.log(`workspace ${ws}`)

  const transcripts = findTranscripts(ws)
  if (showAgents) {
    if (!transcripts.length) {
      console.log(
        "\nNo workflow-agent transcripts in this workspace (run predates them)."
      )
    }
    for (const f of transcripts) dumpTranscript(f)
    return
  }
  if (transcripts.length) {
    console.log(
      `agents   ${transcripts.length} workflow-agent transcript(s) — re-run with --agents`
    )
  }

  let n = 0
  for (const m of msgs) {
    let content
    try {
      content = JSON.parse(m.content)
    } catch {
      console.log(
        `\n=== [${++n}] ${m.role} (unparseable) ===\n${trunc(m.content)}`
      )
      continue
    }
    const parts = content.parts || []
    console.log(
      `\n=== [${++n}] ${String(m.role).toUpperCase()}  ${m.createdAt}  (${parts.length} parts) ===`
    )
    for (const p of parts) render(p)
  }
}

// The recorder/narrator transcripts written by the demo-video workflow.
function findTranscripts(ws) {
  const out = []
  const narration = path.join(ws, "narration.agent.json")
  const scenes = path.join(ws, "scenes")
  try {
    for (const f of fs.readdirSync(scenes).sort()) {
      if (f.endsWith(".agent.json")) out.push(path.join(scenes, f))
    }
  } catch {
    /* no scenes dir */
  }
  if (fs.existsSync(narration)) out.push(narration)
  return out
}

function dumpTranscript(file) {
  let j
  try {
    j = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    console.log(`\n### ${path.basename(file)} — unreadable: ${e.message}`)
    return
  }
  const usage = j.usage ? ` ${j.usage.totalTokens ?? "?"}tok` : ""
  console.log(`\n### ${path.basename(file)}  (${j.modelId || "?"}${usage})`)
  if (j.previousFailure)
    console.log(`  retry after: ${trunc(j.previousFailure)}`)
  if (j.error) console.log(`  ✗ agent threw: ${trunc(j.error)}`)
  const steps = Array.isArray(j.steps) ? j.steps : []
  steps.forEach((step, i) => {
    console.log(`  -- step ${i + 1} --`)
    if ((step.text || "").trim()) console.log(`  text: ${trunc(step.text)}`)
    for (const call of step.toolCalls || []) {
      const pay = call.payload || call
      console.log(
        `  · ${pay.toolName || "?"}(${trunc(pay.args ?? pay.input, full ? TRUNC : 200)})`
      )
    }
    for (const res of step.toolResults || []) {
      const pay = res.payload || res
      const out = pay.result ?? pay.output
      console.log(`  ${isError(out) ? "✗" : "✓"}     → ${trunc(elide(out))}`)
    }
  })
  if ((j.text || "").trim()) console.log(`  final: ${trunc(j.text)}`)
  if (j.object) console.log(`  object: ${trunc(j.object)}`)
}

function render(p) {
  const t = p.type
  if (t === "step-start" || t === "step-finish") return
  if (typeof t === "string" && t.startsWith("data-") && !showData) return

  if (t === "text") {
    if ((p.text || "").trim()) console.log(`  text: ${trunc(p.text)}`)
  } else if (t === "reasoning") {
    console.log(`  reasoning: ${trunc(p.text ?? p.reasoning)}`)
  } else if (t === "tool-invocation") {
    // AI SDK v4-shaped part (what the controller writes today)
    const ti = p.toolInvocation || {}
    const flag = ti.state === "result" ? (isError(ti.result) ? "✗" : "✓") : "·"
    console.log(
      `  ${flag} ${ti.toolName}(${trunc(ti.args, full ? TRUNC : 200)})`
    )
    if (ti.result !== undefined)
      console.log(`      → ${trunc(elide(ti.result))}`)
  } else if (typeof t === "string" && t.startsWith("tool-")) {
    // v5-shaped part (`tool-<name>` with input/output)
    const flag = isError(p.output)
      ? "✗"
      : p.state === "output-available"
        ? "✓"
        : "·"
    console.log(
      `  ${flag} ${t.slice(5)}(${trunc(p.input, full ? TRUNC : 200)})`
    )
    if (p.output !== undefined) console.log(`      → ${trunc(elide(p.output))}`)
  } else if (t === "file") {
    console.log(`  file: ${p.name || p.url || p.mediaType || "?"}`)
  } else {
    console.log(`  ${t}: ${trunc(p)}`)
  }
}

// Screenshots are base64 blobs that would drown the transcript.
function elide(out) {
  if (Array.isArray(out)) {
    return out.map((b) =>
      b && b.type === "image"
        ? { type: "image", mimeType: b.mimeType, bytes: (b.data || "").length }
        : b
    )
  }
  return out
}

function isError(out) {
  if (!out) return false
  if (out.error) return true
  return /✗|ERROR:|Element not found|Ambiguous|Failed|exit (?:code )?[1-9]/i.test(
    JSON.stringify(out).slice(0, 4000)
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
