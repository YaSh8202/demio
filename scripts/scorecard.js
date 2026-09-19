#!/usr/bin/env node
// Print a run's scorecard.
//
// Usage:
//   bun run scorecard              # the most recently written scorecard
//   bun run scorecard <threadId>   # a prefix is enough
//   bun run scorecard --all        # one block per workspace that has one
//   bun run scorecard --json       # raw entries instead of the summary

const fs = require("fs")
const os = require("os")
const path = require("path")
const { summarize } = require("../electron/agent/workflows/scorecard-pure.cjs")

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith("--")))
const want = args.find((a) => !a.startsWith("--"))
const root = path.join(os.homedir(), ".demio", "workspaces")

const cards = (fs.existsSync(root) ? fs.readdirSync(root) : [])
  .map((id) => ({ id, file: path.join(root, id, "scorecard.jsonl") }))
  .filter((c) => fs.existsSync(c.file))
  .map((c) => ({ ...c, mtime: fs.statSync(c.file).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

const picked = flags.has("--all")
  ? cards
  : want
    ? cards.filter((c) => c.id.startsWith(want))
    : cards.slice(0, 1)

if (picked.length === 0) {
  console.error(want ? `no scorecard for a thread starting "${want}"` : "no scorecards yet — they are written by runs made after this was added")
  process.exit(1)
}

for (const c of picked) {
  const entries = fs
    .readFileSync(c.file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  console.log(`\n── ${c.id}  (${new Date(c.mtime).toLocaleString()})`)
  console.log(flags.has("--json") ? JSON.stringify(entries, null, 2) : summarize(entries))
}
