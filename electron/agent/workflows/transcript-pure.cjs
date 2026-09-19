// ── Agent transcript projection (pure) ──────────────────────────────────────
//
// A Mastra `generate()` step carries the whole exchange that produced it:
// `request.body` (every prior message, the system prompt, the tool schemas)
// and `response.messages` / `dbMessages` / `uiMessages` (the conversation so
// far, three times). Written verbatim, a transcript grows with the SQUARE of
// the step count: one 100-step rehearsal came to 159 MB, of which 0.47 MB —
// 0.3% — was what the agent actually did. The rest was the same history
// restated four times per step, stringified synchronously on Electron's main
// thread at the end of every flow.
//
// This keeps what a reviewer reads — what the agent said, which tools it
// called with what arguments, what came back, what it cost — and keeps the
// opening request ONCE, since that is where the system prompt and tool
// schemas live. Nothing here is provider-specific except that pass-through.

/** A single tool result larger than this is cut, with a marker saying so. */
const MAX_RESULT_CHARS = 20_000

function clip(value) {
  if (typeof value === "string") {
    return value.length > MAX_RESULT_CHARS
      ? `${value.slice(0, MAX_RESULT_CHARS)}\n…[${value.length - MAX_RESULT_CHARS} more chars cut from the transcript]`
      : value
  }
  if (value === null || typeof value !== "object") return value
  const text = JSON.stringify(value)
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[${text.length - MAX_RESULT_CHARS} more chars cut from the transcript]`
    : value
}

// Mastra wraps each call/result as `{ type, payload: {...} }`; the AI SDK's
// own shape is flat. Accept both.
const inner = (x) =>
  (x && typeof x === "object" && x.payload ? x.payload : x) || {}

function projectCall(c) {
  const p = inner(c)
  return {
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    args: p.args ?? p.input,
  }
}

function projectResult(r) {
  const p = inner(r)
  const out = {
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    result: clip(p.result ?? p.output),
  }
  if (p.isError === true) out.isError = true
  return out
}

function projectUsage(u) {
  if (!u || typeof u !== "object") return undefined
  const out = {}
  for (const k of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
  ]) {
    if (typeof u[k] === "number") out[k] = u[k]
  }
  return out
}

function projectStep(step) {
  const s = step && typeof step === "object" ? step : {}
  const out = {
    stepType: s.stepType,
    finishReason: s.finishReason,
    text: s.text || "",
    toolCalls: Array.isArray(s.toolCalls) ? s.toolCalls.map(projectCall) : [],
    toolResults: Array.isArray(s.toolResults)
      ? s.toolResults.map(projectResult)
      : [],
    usage: projectUsage(s.usage),
  }
  if (s.reasoningText) out.reasoningText = s.reasoningText
  if (Array.isArray(s.warnings) && s.warnings.length > 0)
    out.warnings = s.warnings
  if (s.response && s.response.modelId) out.modelId = s.response.modelId
  return out
}

/**
 * `{ opening, steps }` — the first request verbatim (system prompt, tool
 * schemas, the opening message: small, because no history exists yet) and
 * every step reduced to what happened in it.
 */
function projectSteps(steps) {
  const list = Array.isArray(steps) ? steps : []
  const first = list[0] && typeof list[0] === "object" ? list[0] : null
  return {
    opening:
      first && first.request
        ? (first.request.body ?? first.request)
        : undefined,
    steps: list.map(projectStep),
  }
}

module.exports = { projectSteps, projectStep, MAX_RESULT_CHARS }
