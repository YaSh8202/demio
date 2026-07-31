#!/usr/bin/env node
// Summarize a demio thread messages.json into a compact trace.
//
// Usage:
//   node summarize-thread.js <path-to-messages.json> [--full]
//   node summarize-thread.js <thread-dir> [--full]
//
// Defaults: prints one compact line per part. With --full, embeds full text/output.
// Tool calls show name + truncated input/output. Errors highlighted with ✗.

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const full = args.includes("--full");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("Usage: summarize-thread.js <messages.json|thread-dir> [--full]");
  process.exit(1);
}

const file = fs.statSync(target).isDirectory()
  ? path.join(target, "messages.json")
  : target;

const raw = fs.readFileSync(file, "utf8");
const messages = JSON.parse(raw);

const TRUNC = full ? 4000 : 200;
const trunc = (s, n = TRUNC) => {
  if (s == null) return "";
  s = typeof s === "string" ? s : JSON.stringify(s);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
};

const stats = {
  turns: 0,
  user: 0,
  assistant: 0,
  toolCalls: {},
  errors: 0,
  totalTokens: 0,
  totalCost: 0,
};

const lines = [];
let turnIdx = 0;

for (const msg of messages) {
  stats.turns++;
  const role = msg.role || "?";
  if (role === "user") stats.user++;
  if (role === "assistant") stats.assistant++;

  const meta = msg.metadata || {};
  if (meta.totalUsage?.totalTokens)
    stats.totalTokens += meta.totalUsage.totalTokens;
  if (meta.cost) stats.totalCost += meta.cost;

  const header =
    `\n=== [${++turnIdx}] ${role.toUpperCase()}` +
    (meta.modelId ? ` (${meta.modelId.split("/").pop()})` : "") +
    (meta.totalUsage?.totalTokens
      ? ` ${meta.totalUsage.totalTokens}tok`
      : "") +
    (meta.status && meta.status !== "complete" ? ` [${meta.status}]` : "") +
    " ===";
  lines.push(header);

  const parts = msg.parts || [];
  for (const part of parts) {
    const t = part.type;
    if (t === "step-start") continue;

    if (t === "text") {
      const txt = part.text || "";
      if (txt.trim()) lines.push(`  text: ${trunc(txt)}`);
    } else if (t === "reasoning") {
      lines.push(`  reasoning: ${trunc(part.text)}`);
    } else if (t && t.startsWith("tool-")) {
      const tool = t.replace(/^tool-/, "");
      stats.toolCalls[tool] = (stats.toolCalls[tool] || 0) + 1;
      const state = part.state || "?";
      const input = part.input || {};
      const inSummary = summarizeInput(tool, input);
      let outSummary = "";
      const out = part.output;
      if (out !== undefined) {
        outSummary = summarizeOutput(tool, out);
      }
      const errOut = isError(out);
      if (errOut) stats.errors++;
      const flag = errOut ? "✗" : state === "output-available" ? "✓" : "·";
      lines.push(
        `  ${flag} ${tool}(${inSummary})` +
          (outSummary ? ` → ${outSummary}` : ` [${state}]`)
      );
    } else if (t === "file") {
      lines.push(`  file: ${part.name || part.url || "?"}`);
    } else if (t === "image") {
      lines.push(`  image: ${part.mediaType || "?"}`);
    } else {
      lines.push(`  ${t}: ${trunc(part)}`);
    }
  }
}

function summarizeInput(tool, input) {
  if (!input || typeof input !== "object") return trunc(input, 80);
  if (tool === "edit" || tool === "write")
    return `${input.filePath || "?"}`;
  if (tool === "read")
    return `${input.filePath || "?"}` +
      (input.offset ? ` @${input.offset}` : "");
  if (tool === "bash" || tool === "terminal")
    return trunc(input.command || input.cmd || "", 200);
  if (tool === "glob") return trunc(input.pattern, 80);
  if (tool === "grep")
    return `${trunc(input.pattern, 60)} ${input.path || ""}`;
  // fallback: keys=values
  return Object.entries(input)
    .map(([k, v]) => `${k}=${trunc(v, 60)}`)
    .join(" ");
}

function summarizeOutput(tool, out) {
  if (out == null) return "";
  if (typeof out === "string") return trunc(out);
  if (typeof out !== "object") return trunc(out);
  // Common shapes
  if (out.error) return `ERROR: ${trunc(out.error)}`;
  if (out.text || out.value) return trunc(out.text || out.value);
  if (out.stdout || out.stderr) {
    const s = (out.stdout || "") + (out.stderr ? "\n" + out.stderr : "");
    return trunc(s);
  }
  if (Array.isArray(out)) return `[${out.length} items] ${trunc(out)}`;
  return trunc(out);
}

function isError(out) {
  if (!out) return false;
  if (out.error) return true;
  const s = JSON.stringify(out);
  return /✗|ERROR:|Element not found|Ambiguous|Failed|panic|exit (?:code )?[1-9]/i.test(
    s
  );
}

console.log("# Thread Trace");
console.log(`File: ${file}`);
console.log(
  `Messages: ${stats.turns} (user=${stats.user}, assistant=${stats.assistant})`
);
console.log(`Tokens (sum totalUsage): ${stats.totalTokens}`);
console.log(`Cost (sum): $${stats.totalCost.toFixed(4)}`);
console.log(`Tool calls: ${JSON.stringify(stats.toolCalls)}`);
console.log(`Apparent errors: ${stats.errors}`);
console.log(lines.join("\n"));
