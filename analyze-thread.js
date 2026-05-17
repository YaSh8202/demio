#!/usr/bin/env node
/**
 * Analyze a messages.json thread to diagnose context bloat.
 * Usage: node analyze-thread.js <path-to-messages.json>
 */

const fs = require('fs');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node analyze-thread.js <path-to-messages.json>');
  process.exit(1);
}

// Rough token estimator: ~4 chars per token
function estimateTokens(val) {
  if (!val) return 0;
  if (typeof val === 'string') return Math.ceil(val.length / 4);
  try { return Math.ceil(JSON.stringify(val).length / 4); } catch { return 0; }
}

// AI SDK tool output is an array of content blocks: {type:'text',text} | {type:'image',data,mimeType}
function estimateOutputTokens(output) {
  if (!output) return { tokens: 0, detail: '' };
  if (typeof output === 'string') return { tokens: estimateTokens(output), detail: `str(${output.length})` };
  if (Array.isArray(output)) {
    let total = 0;
    const parts = [];
    for (const block of output) {
      if (block.type === 'image') {
        const dataLen = (block.data || '').length;
        // Vision: ~85 tokens per 512px tile, rough approx ~1 token per 5 base64 chars
        const imgTokens = Math.ceil(dataLen / 5);
        total += imgTokens;
        parts.push(`image(${block.mimeType || '?'}, b64=${dataLen}, ~${imgTokens}tok)`);
      } else if (block.type === 'text') {
        const t = estimateTokens(block.text);
        total += t;
        parts.push(`text(${t}tok)`);
      } else {
        const t = estimateTokens(block);
        total += t;
        parts.push(`${block.type}(${t}tok)`);
      }
    }
    return { tokens: total, detail: parts.join(' + ') };
  }
  return { tokens: estimateTokens(output), detail: `obj` };
}

const raw = fs.readFileSync(filePath, 'utf8');
const messages = JSON.parse(raw);

const fileSizeKB = (raw.length / 1024).toFixed(1);
const totalEstimatedTokens = Math.ceil(raw.length / 4);

console.log('\n========== THREAD ANALYSIS ==========');
console.log(`File: ${filePath}`);
console.log(`File size: ${fileSizeKB} KB`);
console.log(`Total messages: ${messages.length}`);
console.log(`Estimated tokens (file): ~${totalEstimatedTokens.toLocaleString()}`);
console.log('======================================\n');

const messageBreakdowns = [];
let grandTotal = 0;

for (let i = 0; i < messages.length; i++) {
  const msg = messages[i];
  const role = msg.role || 'unknown';
  const parts = msg.parts || [];

  const partBreakdowns = [];
  let msgTokens = 0;

  for (const part of parts) {
    const type = part.type || 'unknown';
    let tokens = 0;
    let detail = '';

    const inputTokens = estimateTokens(part.input);
    const { tokens: outputTokens, detail: outputDetail } = estimateOutputTokens(part.output);

    if (type === 'text') {
      tokens = estimateTokens(part.text);
      detail = `"${(part.text || '').slice(0, 80).replace(/\n/g, ' ')}"`;
    } else if (type === 'reasoning') {
      tokens = estimateTokens(part.text);
      detail = `len=${(part.text || '').length}`;
    } else if (type === 'tool-read') {
      tokens = inputTokens + outputTokens;
      detail = `input=${inputTokens} output=${outputTokens} [${outputDetail}] file=${part.input?.filePath || '?'}`;
    } else if (type === 'tool-terminal') {
      tokens = inputTokens + outputTokens;
      detail = `input=${inputTokens} output=${outputTokens} [${outputDetail}] cmd="${String(part.input?.command || part.input?.cmd || '').slice(0, 60)}"`;
    } else if (type === 'tool-edit') {
      tokens = inputTokens + outputTokens;
      detail = `input=${inputTokens} output=${outputTokens} file=${part.input?.filePath || '?'}`;
    } else if (type === 'tool-screenshot' || type === 'tool-browser') {
      tokens = inputTokens + outputTokens;
      detail = `input=${inputTokens} output=${outputTokens} [${outputDetail}]`;
    } else {
      tokens = estimateTokens(part);
      detail = '(full part)';
    }

    msgTokens += tokens;
    partBreakdowns.push({ type, tokens, detail });
  }

  const metaTokens = estimateTokens(msg.metadata || {});
  msgTokens += metaTokens;
  grandTotal += msgTokens;

  messageBreakdowns.push({ index: i, role, msgTokens, partBreakdowns, metaTokens });
}

// Per-message
for (const mb of messageBreakdowns) {
  console.log(`--- Message ${mb.index} [${mb.role}] — ~${mb.msgTokens.toLocaleString()} tokens ---`);
  const sorted = [...mb.partBreakdowns].sort((a, b) => b.tokens - a.tokens);
  for (const p of sorted) {
    if (p.tokens < 10) continue;
    const pct = mb.msgTokens > 0 ? ((p.tokens / mb.msgTokens) * 100).toFixed(1) : '0.0';
    console.log(`  ${p.type.padEnd(22)} ${String(p.tokens.toLocaleString()).padStart(10)} tokens (${pct}%) — ${p.detail}`);
  }
  if (mb.metaTokens > 10) {
    console.log(`  ${'[metadata]'.padEnd(22)} ${String(mb.metaTokens.toLocaleString()).padStart(10)} tokens`);
  }
  console.log();
}

// By role
const byRole = {};
for (const mb of messageBreakdowns) byRole[mb.role] = (byRole[mb.role] || 0) + mb.msgTokens;

// By part type
const byPartType = {};
for (const mb of messageBreakdowns)
  for (const p of mb.partBreakdowns)
    byPartType[p.type] = (byPartType[p.type] || 0) + p.tokens;

console.log('========== SUMMARY ==========');
console.log(`Grand total estimated tokens: ~${grandTotal.toLocaleString()}`);
console.log('\nBy role:');
for (const [role, tokens] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) {
  const pct = ((tokens / grandTotal) * 100).toFixed(1);
  console.log(`  ${role.padEnd(12)} ${String(tokens.toLocaleString()).padStart(12)} tokens (${pct}%)`);
}
console.log('\nBy part type:');
for (const [type, tokens] of Object.entries(byPartType).sort((a, b) => b - a)) {
  const pct = ((tokens / grandTotal) * 100).toFixed(1);
  console.log(`  ${type.padEnd(24)} ${String(tokens.toLocaleString()).padStart(12)} tokens (${pct}%)`);
}

// Top 10 parts
const allParts = [];
for (const mb of messageBreakdowns)
  for (const p of mb.partBreakdowns)
    allParts.push({ msgIdx: mb.index, role: mb.role, ...p });
allParts.sort((a, b) => b.tokens - a.tokens);

console.log('\nTop 10 biggest parts:');
for (const p of allParts.slice(0, 10)) {
  const pct = grandTotal > 0 ? ((p.tokens / grandTotal) * 100).toFixed(1) : '0.0';
  console.log(`  msg[${p.msgIdx}] ${p.role.padEnd(10)} ${p.type.padEnd(22)} ${String(p.tokens.toLocaleString()).padStart(12)} tokens (${pct}%) — ${p.detail}`);
}

// Diagnosis
console.log('\n========== BLOAT DIAGNOSIS ==========');
const toolReadTokens = byPartType['tool-read'] || 0;
const toolTerminalTokens = byPartType['tool-terminal'] || 0;
const reasoningTokens = byPartType['reasoning'] || 0;

const issues = [];

if (toolReadTokens > 50000) {
  issues.push({
    issue: `tool-read outputs are huge (likely images/large files)`,
    tokens: toolReadTokens,
    fix: 'Never read binary files (images, PDFs) via tool-read into message history. For screenshots, store externally and pass only a text description or file path. For large text files, read only relevant line ranges.',
  });
}

if (toolTerminalTokens > 50000) {
  issues.push({
    issue: 'Large terminal outputs',
    tokens: toolTerminalTokens,
    fix: 'Truncate terminal output at ~500 lines or ~8k tokens. Store full output to a temp file, pass only head+tail to the model.',
  });
}

if (reasoningTokens > 100000) {
  issues.push({
    issue: 'Accumulated reasoning/CoT text',
    tokens: reasoningTokens,
    fix: 'Strip reasoning parts when building the messages array sent to the API. CoT is only needed for the current turn.',
  });
}

if (messages.length > 20) {
  issues.push({
    issue: `Too many messages (${messages.length})`,
    tokens: grandTotal,
    fix: 'Rolling window: summarize + drop old messages past a token budget (e.g. 80k tokens).',
  });
}

if (issues.length === 0) {
  issues.push({
    issue: 'General accumulation',
    tokens: grandTotal,
    fix: 'Add a token budget guard: track running total after each tool result, trigger compaction at 80% of model limit.',
  });
}

for (const issue of issues) {
  const pct = grandTotal > 0 ? ((issue.tokens / grandTotal) * 100).toFixed(1) : '0.0';
  console.log(`\n[!] ${issue.issue} (~${issue.tokens.toLocaleString()} tokens, ${pct}% of total)`);
  console.log(`    Fix: ${issue.fix}`);
}

console.log('\n========== RECOMMENDATIONS ==========');
console.log(`
1. NEVER READ BINARY FILES INTO CONTEXT
   Screenshots, images, PDFs — reading them via tool-read injects massive base64 blobs.
   Store them to disk, pass only the file path + a short description to the model.

2. TOKEN BUDGET GUARD
   After each tool result, check running token total. If > 80% of model limit, trigger
   compaction before the next LLM call.

3. TRUNCATE TERMINAL OUTPUTS
   Keep first 50 + last 50 lines, discard middle. Add "[truncated N lines]" marker.
   Store full output to a temp file for the model to read if needed.

4. STRIP REASONING FROM HISTORY
   Reasoning (CoT) parts are only needed for the current turn. Remove them from prior
   messages when building the messages array for the API.

5. ROLLING WINDOW / SUMMARIZATION
   When total tokens > threshold, summarize earlier messages into a single context
   summary and drop the originals.
`);
