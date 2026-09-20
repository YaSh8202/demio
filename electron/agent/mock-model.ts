// ── Scripted "bad model" for the harness tests ───────────────────────────────
//
// `mock:<behaviour>` as a model id, only when DEMIO_MOCK_MODEL is set (see
// `getModel`). The stall ladder exists for a model that stops early; waiting
// for a real one to do it on cue is not a test.
//
//   mock:ends-early   every turn is one line of plain text, then stop — the
//                     weak model that asks "shall I proceed?" and waits

import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

export function mockModel(behaviour: string) {
  if (behaviour !== "ends-early") {
    throw new Error(`mock model: unknown behaviour "${behaviour}"`)
  }
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: behaviour,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          {
            type: "text-delta",
            id: "t1",
            delta: "Shall I go ahead and record it?",
          },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage,
          },
        ],
      }),
    }),
  })
}
