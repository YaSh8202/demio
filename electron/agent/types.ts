// ── Agent Types ──────────────────────────────────────────────────────────────

/**
 * Default model when project has no selection.
 *
 * Sonnet rather than Haiku because demo recording requires durable
 * locator-recovery reasoning: Haiku 4.5 was observed giving up after 2-3
 * ambiguity errors and incorrectly blaming user credentials when the real
 * cause was a hydration ghost or shadcn duplicate-span button. Users can
 * still pick any model via the provider selector — this only affects the
 * first-run default.
 */
export const DEFAULT_MODEL_ID = "anthropic:claude-sonnet-4-6"

/**
 * Split a `provider:model` id into its halves.
 *
 * Lives here rather than next to `getModel` so callers that only need to read
 * the id — pricing lookups, for one — don't pull in the encrypted key store.
 */
export function parseModelId(fullModelId: string): {
  provider: string
  modelId: string
} {
  const colonIndex = fullModelId.indexOf(":")
  if (colonIndex === -1) {
    // Legacy bare model ID — assume Anthropic
    return { provider: "anthropic", modelId: fullModelId }
  }
  return {
    provider: fullModelId.slice(0, colonIndex),
    modelId: fullModelId.slice(colonIndex + 1),
  }
}
