// Pure verification predicates shared by verify.ts. CommonJS so node --test
// runs them directly with zero build step.
"use strict"

function parseActionsLog(jsonl) {
  const lines = String(jsonl)
    .split("\n")
    .filter((l) => l.trim().length > 0)
  const failed = []
  lines.forEach((line, i) => {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      failed.push({
        line: i + 1,
        action: "<unparseable>",
        error: "invalid JSON",
      })
      return
    }
    if (entry.ok !== true) {
      failed.push({
        line: i + 1,
        action: entry.action ?? "<unknown>",
        error: entry.error ?? "action reported ok:false",
      })
    }
  })
  return { total: lines.length, failed }
}

module.exports = { parseActionsLog }
