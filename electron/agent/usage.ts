// ── Run Usage & Cost ─────────────────────────────────────────────────────────
//
// Turns the token usage Mastra reports for a finished run into the
// `MessageMetadata` fields persisted alongside the assistant message
// (`totalUsage`, `cost`, `messageTokens`).
//
// Two shape conversions happen here, and they are easy to confuse:
//
//   1. Mastra's usage is *flat* (`inputTokens`, `cachedInputTokens`, …) while
//      `MessageMetadata.totalUsage` is ai-sdk v6's `LanguageModelUsage`, which
//      nests cache/reasoning counts under `inputTokenDetails` /
//      `outputTokenDetails`. `toV6Usage` bridges the two.
//   2. tokenlens prices a `TokenBreakdown` (`input`/`output`/`cacheReads`/…),
//      which is a third naming again. `toBreakdown` bridges that.
//
// Prices come from models.dev via tokenlens — the same catalog the renderer's
// model picker reads (`src/lib/models-dev.ts`), so the price shown next to a
// model and the price a run is billed at cannot drift apart.
//
// Deliberately NOT used as a fallback: the bundled offline catalog in
// `@tokenlens/models`. It is a snapshot frozen at package-publish time and its
// newest Anthropic entry predates every model Demio ships with, so it would
// price current runs at $0 — silently, and wrongly. No price beats a wrong one.

import fs from "node:fs"
import { fetchModels } from "tokenlens"
import { getTokenCosts } from "@tokenlens/helpers"
import type { ModelCatalog } from "@tokenlens/core"
import type { LanguageModelUsage } from "ai"
import { parseModelId } from "./types"
import { modelPricingCachePath, atomicWrite } from "../store/paths"
import type { MessageMetadata, TokenCosts } from "../store/types"
import log from "../lib/logger"

/**
 * Usage as Mastra reports it (`MastraModelOutput.totalUsage`). Structural rather
 * than imported: `@mastra/core` does not re-export the type from its public
 * entrypoint, and every field is optional anyway.
 */
export interface MastraUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
}

// ── Pricing catalog ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_VERSION = 1

interface PricingCache {
  version: number
  fetchedAt: number
  catalog: ModelCatalog
}

let memo: PricingCache | null = null
/** De-dupes concurrent misses so parallel runs share one network round-trip. */
let inFlight: Promise<ModelCatalog | null> | null = null

/**
 * Keep only what pricing needs. The full models.dev payload is ~3 MB of
 * modalities, limits, release dates and knowledge cutoffs; the price table is
 * a few KB of it, and this file gets rewritten on every refresh.
 */
function trimToPrices(catalog: ModelCatalog): ModelCatalog {
  const trimmed: ModelCatalog = {}
  for (const [providerId, provider] of Object.entries(catalog)) {
    const models: (typeof provider)["models"] = {}
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (model?.cost) {
        models[modelId] = { id: model.id, name: model.name, cost: model.cost }
      }
    }
    if (Object.keys(models).length) {
      trimmed[providerId] = { ...provider, models }
    }
  }
  return trimmed
}

function readDiskCache(): PricingCache | null {
  try {
    const raw = fs.readFileSync(modelPricingCachePath(), "utf-8")
    const parsed = JSON.parse(raw) as PricingCache
    if (parsed?.version !== CACHE_VERSION || !parsed.catalog) return null
    return parsed
  } catch {
    return null
  }
}

function isFresh(cache: PricingCache | null): boolean {
  return !!cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS
}

/**
 * The models.dev catalog, from memory → disk → network in that order.
 *
 * A stale cache is still returned when the network is unreachable: last week's
 * prices are a far better answer than none. Returns null only when there has
 * never been a successful fetch on this machine.
 */
async function getCatalog(): Promise<ModelCatalog | null> {
  if (isFresh(memo)) return memo!.catalog

  if (!memo) {
    const disk = readDiskCache()
    if (disk) {
      memo = disk
      if (isFresh(disk)) return disk.catalog
    }
  }

  if (inFlight) return inFlight

  const stale = memo?.catalog ?? null
  inFlight = (async () => {
    try {
      const catalog = trimToPrices(await fetchModels())
      memo = { version: CACHE_VERSION, fetchedAt: Date.now(), catalog }
      await atomicWrite(modelPricingCachePath(), JSON.stringify(memo))
      return catalog
    } catch (err) {
      log.warn(
        "[usage] models.dev pricing fetch failed" +
          (stale ? ", using stale cache" : ", cost will be omitted") +
          ":",
        err
      )
      return stale
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/** Warm the pricing cache at startup so the first run doesn't pay the fetch. */
export function initPricing(): void {
  void getCatalog()
}

// ── Conversions ──────────────────────────────────────────────────────────────

/**
 * Mastra's flat usage → ai-sdk v6's nested `LanguageModelUsage`.
 *
 * `noCacheTokens` mirrors `inputTokens` because providers already report
 * cache reads/writes as separate counters — `inputTokens` is the uncached
 * remainder, not the total.
 */
export function toV6Usage(usage: MastraUsage | undefined): LanguageModelUsage {
  return {
    inputTokens: usage?.inputTokens,
    inputTokenDetails: {
      noCacheTokens: usage?.inputTokens,
      cacheReadTokens: usage?.cachedInputTokens,
      cacheWriteTokens: usage?.cacheCreationInputTokens,
    },
    outputTokens: usage?.outputTokens,
    outputTokenDetails: {
      textTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
    },
    totalTokens: usage?.totalTokens,
  }
}

/**
 * ai-sdk v7's nested usage → Mastra's flat shape.
 *
 * The inverse of `toV6Usage`, needed because the live stream hands us usage
 * that Mastra has *already* normalized to v7 while pricing works off the flat
 * counters. v7 dropped the deprecated top-level `reasoningTokens` /
 * `cachedInputTokens` aliases `toV6Usage` used to also write — read the
 * nested details only.
 */
export function fromV6Usage(
  usage: LanguageModelUsage | undefined
): MastraUsage {
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens,
    cacheCreationInputTokens: usage?.inputTokenDetails?.cacheWriteTokens,
  }
}

function toBreakdown(usage: MastraUsage) {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    total: usage.totalTokens,
    cacheReads: usage.cachedInputTokens,
    cacheWrites: usage.cacheCreationInputTokens,
    reasoningTokens: usage.reasoningTokens,
  }
}

/**
 * Price a run against an already-loaded catalog.
 *
 * Returns null when the model has no entry — `getTokenCosts` answers `{}` for
 * an unknown model, which must not be recorded as "this run was free".
 */
function priceWith(
  catalog: ModelCatalog | null,
  fullModelId: string,
  usage: MastraUsage
): TokenCosts | null {
  if (!catalog) return null

  // `fullModelId` is Demio's `provider:model`; models.dev keys providers by the
  // same ids we use (openai / anthropic / google / amazon-bedrock), so the
  // provider half indexes the catalog directly.
  const { provider, modelId } = parseModelId(fullModelId)
  const providerInfo = catalog[provider]
  if (!providerInfo) return null

  try {
    const costs = getTokenCosts({
      modelId,
      usage: toBreakdown(usage),
      providers: providerInfo,
    })
    return costs.totalUSD === undefined ? null : costs
  } catch (err) {
    log.warn(`[usage] cost calculation failed for ${fullModelId}:`, err)
    return null
  }
}

/** Price a run in USD, loading the catalog if it isn't cached yet. */
export async function computeCost(
  fullModelId: string,
  usage: MastraUsage
): Promise<TokenCosts | null> {
  return priceWith(await getCatalog(), fullModelId, usage)
}

/**
 * Price a run without awaiting anything, for callers that cannot be async —
 * notably the `messageMetadata` callback on the live stream.
 *
 * Yields null until the catalog is in memory. `initPricing()` warms it at
 * startup, so in practice only a run started seconds into a cold, offline-ish
 * launch streams without a price; the authoritative figure is computed again
 * (with an await) when the run is persisted.
 */
export function computeCostSync(
  fullModelId: string,
  usage: MastraUsage
): TokenCosts | null {
  return priceWith(memo?.catalog ?? null, fullModelId, usage)
}

// TODO(ADR-008): orphaned since the orchestrator was deleted (Task 7) — per-message usage/cost has no producer; thread-level usage flows via useAgentEvents().usage. Rewire or remove when the controller exposes per-message usage.
/**
 * Build the usage-related slice of `MessageMetadata` for a finished run.
 *
 * `messageTokens` is the assistant message's own output size — what it will
 * contribute to context on the next turn — not the whole run's token spend.
 */
export async function buildUsageMetadata(
  fullModelId: string,
  usage: MastraUsage | undefined
): Promise<Pick<MessageMetadata, "totalUsage" | "cost" | "messageTokens">> {
  return {
    totalUsage: toV6Usage(usage),
    cost: usage ? await computeCost(fullModelId, usage) : null,
    messageTokens: usage?.outputTokens ?? 0,
  }
}

// TODO(ADR-008): orphaned since the orchestrator was deleted (Task 7) — per-message usage/cost has no producer; thread-level usage flows via useAgentEvents().usage. Rewire or remove when the controller exposes per-message usage.
/**
 * Metadata to ride the live stream when a run reports its totals, so the
 * renderer can show tokens and cost the moment they are known rather than only
 * after the thread is reloaded.
 *
 * `status` is deliberately null: whether the run completed or was cancelled
 * isn't decided until `onFinish`, which persists the authoritative metadata.
 */
export function buildLiveUsageMetadata(
  fullModelId: string,
  usage: LanguageModelUsage | undefined
): MessageMetadata {
  const flat = fromV6Usage(usage)
  return {
    modelId: fullModelId,
    status: null,
    totalUsage: usage ?? toV6Usage(flat),
    cost: usage ? computeCostSync(fullModelId, flat) : null,
    messageTokens: flat.outputTokens ?? 0,
  }
}
