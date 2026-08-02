// Pure verification predicates shared by verify.ts. CommonJS so node --test
// runs them directly with zero build step.
"use strict"

function parseActionsLog(jsonl) {
  const lines = String(jsonl).split("\n").filter((l) => l.trim().length > 0)
  const failed = []
  lines.forEach((line, i) => {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      failed.push({ line: i + 1, action: "<unparseable>", error: "invalid JSON" })
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

function checkDurationRange(durationSec, scene) {
  const min = scene.minDurationSec ?? 4
  const max = scene.maxDurationSec ?? 90
  const ok = durationSec >= min && durationSec <= max
  return {
    ok,
    detail: ok
      ? `duration ${durationSec}s within [${min}, ${max}]`
      : `duration ${durationSec}s outside [${min}, ${max}]`,
  }
}

function normalizeUrl(u) {
  try {
    const url = new URL(u)
    url.hash = ""
    return url.toString().replace(/\/+$/, "")
  } catch {
    return String(u).replace(/\/+$/, "")
  }
}

function checkEndUrl(finalUrl, scene) {
  const actual = normalizeUrl(finalUrl)
  const expected = normalizeUrl(scene.endUrl)
  const ok = actual.startsWith(expected)
  return {
    ok,
    detail: ok
      ? `final url matches ${expected}`
      : `final url ${actual} does not start with ${expected}`,
  }
}

module.exports = { parseActionsLog, checkDurationRange, checkEndUrl }
