// ── Usage Pricing ────────────────────────────────────────────────────────────
//
// Prices a thread's cumulative token usage in USD for the header readout
// (`src/components/thread/thread-usage.tsx`).
//
// Only the renderer knows which usage figure is on screen, and only main can
// price it (`electron/agent/usage.ts` reads the models.dev catalog off disk /
// the network via tokenlens), so this is the seam between them. It is a pure
// function of its arguments — no session, no thread lookup.

import type { NamespaceHandlers } from "../constants"
import { computeCost } from "../agent/usage"
import type { MastraUsage } from "../agent/usage"
import type { TokenCosts } from "../store/types"

/**
 * The controller's cumulative usage shape (`TokenUsage`,
 * `@mastra/core/dist/agent-controller/types.d.ts`) as it arrives over IPC.
 * Deliberately not imported: pulling the agent-controller types into a
 * handler for six optional numbers isn't worth the coupling.
 */
interface ControllerTokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
}

/**
 * Controller usage -> the flat shape `computeCost` prices.
 *
 * The one non-obvious hop is `inputTokens`. `promptTokens` is the provider's
 * FULL prompt count, cache reads included — verified against a persisted
 * thread whose `totalTokens` equals `promptTokens + completionTokens` exactly
 * while `cachedInputTokens` is a large fraction of `promptTokens`, and
 * against Mastra's own per-step normalization (`inputTokens: {total, noCache,
 * cacheRead}`, where `noCache === total - cacheRead`). tokenlens prices
 * `input` and `cacheReads` as separate line items at different rates, so
 * passing `promptTokens` straight through would bill every cached token twice
 * — once at the full input rate and again at the cache-read rate. Subtract to
 * get the uncached remainder, mirroring Mastra's `noCache`.
 *
 * `cacheCreationInputTokens` is NOT subtracted: Mastra doesn't subtract it
 * either, and providers that report cache writes (Anthropic) already keep
 * them out of the prompt count.
 */
function toFlatUsage(usage: ControllerTokenUsage): MastraUsage {
  const prompt = usage.promptTokens ?? 0
  const cacheRead = usage.cachedInputTokens ?? 0
  return {
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
  }
}

export const usageHandlers = {
  /**
   * Price `usage` against `fullModelId` (Demio's `provider:model`).
   *
   * Null when the model has no catalog entry or the catalog has never been
   * fetched on this machine — callers render tokens without a price rather
   * than showing a wrong or free-looking one.
   */
  price: async (
    _event: Electron.IpcMainInvokeEvent,
    fullModelId: string,
    usage: ControllerTokenUsage
  ): Promise<TokenCosts | null> => {
    if (!fullModelId) return null
    return computeCost(fullModelId, toFlatUsage(usage))
  },
} satisfies NamespaceHandlers
