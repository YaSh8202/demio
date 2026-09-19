const test = require("node:test")
const assert = require("node:assert")
const { projectSteps, MAX_RESULT_CHARS } = require("./transcript-pure.cjs")

// The shape Mastra's generate() actually returns (probed from a real run):
// calls and results wrapped in `payload`, and the whole conversation
// restated on every step under request/response.
function rawStep(i, history) {
  return {
    stepType: "tool-result",
    finishReason: "tool-calls",
    text: "",
    reasoningText: "",
    warnings: [],
    toolCalls: [
      {
        type: "tool-call",
        runId: "r",
        from: "AGENT",
        payload: {
          toolCallId: `call_${i}`,
          toolName: "mastra_workspace_execute_command",
          args: { command: "agent-browser snapshot -i", description: "look" },
          providerMetadata: { google: { thoughtSignature: "x".repeat(500) } },
        },
      },
    ],
    toolResults: [
      {
        type: "tool-result",
        payload: {
          toolCallId: `call_${i}`,
          toolName: "mastra_workspace_execute_command",
          args: { command: "agent-browser snapshot -i" },
          result: `- heading "Step ${i}"`,
        },
      },
    ],
    usage: {
      inputTokens: 100 + i,
      outputTokens: 5,
      totalTokens: 105 + i,
      raw: { big: "y".repeat(300) },
    },
    providerMetadata: { google: { usageMetadata: {} } },
    request: {
      body: { systemInstruction: "SYS", tools: ["t"], contents: history },
    },
    response: {
      id: "resp",
      modelId: "gemini-3.8-flash",
      headers: {},
      body: {},
      messages: history,
      dbMessages: history,
      uiMessages: history,
    },
  }
}

test("projectSteps: keeps what the agent did, per step", () => {
  const { steps } = projectSteps([rawStep(0, ["m0"])])
  assert.deepEqual(steps[0].toolCalls, [
    {
      toolCallId: "call_0",
      toolName: "mastra_workspace_execute_command",
      args: { command: "agent-browser snapshot -i", description: "look" },
    },
  ])
  assert.equal(steps[0].toolResults[0].result, '- heading "Step 0"')
  assert.deepEqual(steps[0].usage, {
    inputTokens: 100,
    outputTokens: 5,
    totalTokens: 105,
  })
  assert.equal(steps[0].modelId, "gemini-3.8-flash")
  assert.equal(steps[0].finishReason, "tool-calls")
})

test("projectSteps: drops the restated history and provider blobs", () => {
  const text = JSON.stringify(
    projectSteps([rawStep(0, ["m0"]), rawStep(1, ["m0", "m1"])]).steps
  )
  for (const gone of [
    "dbMessages",
    "uiMessages",
    "thoughtSignature",
    '"request"',
    '"response"',
    '"raw"',
  ]) {
    assert.ok(!text.includes(gone), gone)
  }
})

test("projectSteps: the opening request is kept once", () => {
  const out = projectSteps([rawStep(0, ["m0"]), rawStep(1, ["m0", "m1"])])
  assert.deepEqual(out.opening, {
    systemInstruction: "SYS",
    tools: ["t"],
    contents: ["m0"],
  })
  assert.equal(JSON.stringify(out).split("SYS").length - 1, 1)
})

test("projectSteps: size is linear in steps, not quadratic", () => {
  // Each step restates a history that grows by 2 KB per step — the real
  // failure mode. Raw grows with n²; the projection must not.
  const make = (n) => {
    const history = []
    return Array.from({ length: n }, (_, i) => {
      history.push("h".repeat(2000))
      return rawStep(i, [...history])
    })
  }
  const size = (n) => JSON.stringify(projectSteps(make(n))).length
  const raw = (n) => JSON.stringify(make(n)).length
  assert.ok(raw(100) / raw(10) > 50, "fixture is quadratic")
  assert.ok(
    size(100) / size(10) < 12,
    `projection grew ${size(100) / size(10)}x for 10x steps`
  )
})

test("projectSteps: an oversized tool result is cut, and says so", () => {
  const s = rawStep(0, [])
  s.toolResults[0].payload.result = "z".repeat(MAX_RESULT_CHARS + 500)
  const r = projectSteps([s]).steps[0].toolResults[0].result
  assert.ok(r.length < MAX_RESULT_CHARS + 100)
  assert.match(r, /500 more chars cut from the transcript/)
})

test("projectSteps: accepts the AI SDK's flat shape and an error result", () => {
  const out = projectSteps([
    {
      toolCalls: [{ toolCallId: "a", toolName: "t", input: { x: 1 } }],
      toolResults: [
        { toolCallId: "a", toolName: "t", output: "boom", isError: true },
      ],
    },
  ]).steps[0]
  assert.deepEqual(out.toolCalls[0], {
    toolCallId: "a",
    toolName: "t",
    args: { x: 1 },
  })
  assert.deepEqual(out.toolResults[0], {
    toolCallId: "a",
    toolName: "t",
    result: "boom",
    isError: true,
  })
})

test("projectSteps: tolerates junk", () => {
  assert.deepEqual(projectSteps(undefined), { opening: undefined, steps: [] })
  assert.equal(projectSteps([null, 3, "x"]).steps.length, 3)
})
