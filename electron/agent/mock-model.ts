// ── Scripted "bad model" for the harness tests ───────────────────────────────
//
// `mock:<behaviour>` as a model id, only when DEMIO_MOCK_MODEL is set (see
// `getModel`). The stall ladder exists for a model that stops early; waiting
// for a real one to do it on cue is not a test.
//
//   mock:ends-early   every turn is one line of plain text, then stop — the
//                     weak model that asks "shall I proceed?" and waits
//   mock:flails       never stops calling a workspace tool — the model that
//                     cannot get past an obstacle and pokes at it forever
//   mock:looks-around its first call lists the workspace, then it answers in
//                     plain text — a model answering a QUESTION, which used a
//                     tool and is not a stalled demo

import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

// Derived from the mock rather than imported: `@ai-sdk/provider` is only a
// transitive dependency here.
type LanguageModelV4StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const text = (delta: string): LanguageModelV4StreamPart[] => [
  { type: "stream-start" as const, warnings: [] },
  { type: "text-start" as const, id: "t1" },
  { type: "text-delta" as const, id: "t1", delta },
  { type: "text-end" as const, id: "t1" },
  {
    type: "finish" as const,
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage,
  },
]

// `getModel` builds a fresh instance per request, so a script that spans
// calls keeps its place here.
let looksAroundCalls = 0

export function mockModel(behaviour: string) {
  if (behaviour === "ends-early") {
    return new MockLanguageModelV4({
      provider: "mock",
      modelId: behaviour,
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: text("Shall I go ahead and record it?"),
        }),
      }),
    })
  }
  if (behaviour === "looks-around") {
    return new MockLanguageModelV4({
      provider: "mock",
      modelId: behaviour,
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks:
            looksAroundCalls++ === 0
              ? [
                  { type: "stream-start" as const, warnings: [] },
                  {
                    type: "tool-call" as const,
                    toolCallId: "call_look",
                    toolName: "mastra_workspace_list_files",
                    input: JSON.stringify({ path: "." }),
                  },
                  {
                    type: "finish" as const,
                    finishReason: {
                      unified: "tool-calls" as const,
                      raw: "tool_calls",
                    },
                    usage,
                  },
                ]
              : text("The site has a homepage and a pricing page."),
        }),
      }),
    })
  }
  if (behaviour === "flails") {
    let n = 0
    return new MockLanguageModelV4({
      provider: "mock",
      modelId: behaviour,
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: `call_flail_${Date.now()}_${n++}`,
              toolName: "mastra_workspace_list_files",
              input: JSON.stringify({ path: "." }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage,
            },
          ],
        }),
      }),
    })
  }
  throw new Error(`mock model: unknown behaviour "${behaviour}"`)
}
