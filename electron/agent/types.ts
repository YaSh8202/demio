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
