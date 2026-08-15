// ── Thread Usage Readout ─────────────────────────────────────────────────────
//
// Cumulative tokens for the whole thread — plus USD, but only when the whole
// thread ran on the model the selector currently names. Shown in the
// composer's tool row (`thread-shell.tsx`), right of that selector.
//
// THREAD-level, not per-message — that distinction is forced by the data, not
// a design preference. Mastra keeps one running tally per thread and persists
// it in the thread's metadata, so it survives a refresh; persisted assistant
// messages carry `modelId`/`provider` but no token counts, which is why
// `message-usage.tsx`'s per-turn badge has had no producer since Task 7.
//
// That same gap is why cost is conditional: with tokens attributable to the
// thread but not to any individual model within it, a thread that switched
// models has no honest price — see `ranOnSelectedModel` below.
//
// Pricing round-trips to main (`apis.usage.price`) because the models.dev
// catalog lives there — see `electron/handlers/usage.ts`.

import { useEffect, useState } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useActiveThread } from "@/hooks/use-active-thread"
import { apis } from "@/types/electron-api"
import log from "@/lib/logger"
import type { TokenCosts } from "@electron/store/types"

/** Compact token count: 812, 1.2k, 148k. Mirrors `message-usage.tsx`. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
}

/** USD at a precision that stays readable across four orders of magnitude. */
function formatUSD(usd: number): string {
  if (usd === 0) return "$0"
  if (usd < 0.0001) return "<$0.0001"
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** A priced result plus the exact inputs it was computed from, so a stale
 * price is never rendered next to a newer token count (which is what a plain
 * `cost` state would do between the tally updating and its request landing).
 * Carrying the key in state also keeps the effect free of a synchronous
 * `setState` reset — see `react-hooks/set-state-in-effect`. */
interface PricedUsage {
  key: string
  cost: TokenCosts | null
}

export function ThreadUsage() {
  const { usage, selectedModel, threadModelIds } = useActiveThread()
  const [priced, setPriced] = useState<PricedUsage | null>(null)

  const total = usage?.totalTokens ?? 0
  // Preload wrappers are generated from the handler metadata main passes at
  // window creation, so a renderer hot-reloaded against a main process that
  // started before the `usage` namespace existed has no wrapper to call.
  // Distinguished from a genuinely unpriceable model below — "price
  // unavailable" would be a wrong diagnosis for a stale-preload session.
  const pricingSupported = Boolean(apis?.usage?.price)

  // Usage is ONE cumulative tally for the thread with no per-model (or even
  // per-message) split — Mastra records `modelId` on each assistant message
  // but no tokens alongside it, and the tracing table demio would otherwise
  // mine for per-call usage is unused (traces go to Phoenix). So the moment a
  // thread has run on more than one model, no honest price exists: the tokens
  // cannot be attributed. Same if the selector now points somewhere the
  // thread never ran — pricing 418k of Gemini tokens at Claude's rate is
  // fiction. Show tokens alone in both cases rather than a confident wrong
  // number. `selectedModel` is `provider:model`, message metadata is the bare
  // model id, so compare on the model half.
  const ranOnSelectedModel =
    threadModelIds.length === 1 &&
    threadModelIds[0] === selectedModel.split(":").pop()
  const priceKey = `${selectedModel}|${total}`

  // Re-priced whenever the tally or the model changes. Cheap (the catalog is
  // memoized in main after the first call) and idempotent, so no debounce —
  // but the response is dropped if a newer request superseded it.
  useEffect(() => {
    const price = apis?.usage?.price
    if (!price || !usage || total === 0 || !selectedModel) return
    if (!ranOnSelectedModel) return
    let cancelled = false
    void price(selectedModel, usage)
      .then((next: TokenCosts | null) => {
        if (!cancelled) setPriced({ key: priceKey, cost: next })
      })
      .catch((error: unknown) => {
        log.error("[ThreadUsage] pricing failed:", error)
        if (!cancelled) setPriced({ key: priceKey, cost: null })
      })
    return () => {
      cancelled = true
    }
  }, [usage, total, selectedModel, priceKey, ranOnSelectedModel])

  if (!usage || total === 0) return null

  const cost =
    ranOnSelectedModel && priced?.key === priceKey ? priced.cost : null

  const cacheRead = usage.cachedInputTokens ?? 0
  const cacheWrite = usage.cacheCreationInputTokens ?? 0
  const reasoning = usage.reasoningTokens ?? 0
  // `promptTokens` includes cache reads (see `toFlatUsage` in
  // electron/handlers/usage.ts) — break it out so the rows don't imply the
  // uncached input was larger than it was.
  const uncachedInput = Math.max(0, usage.promptTokens - cacheRead)

  const rows: Array<[string, number, number | undefined]> = [
    ["Input", uncachedInput, cost?.inputUSD],
    ["Output", usage.completionTokens, cost?.outputUSD],
  ]
  if (reasoning) rows.push(["Reasoning", reasoning, cost?.reasoningUSD])
  if (cacheRead) rows.push(["Cache read", cacheRead, cost?.cacheReadUSD])
  if (cacheWrite) rows.push(["Cache write", cacheWrite, cost?.cacheWriteUSD])

  const summary = [
    formatTokens(total),
    cost?.totalUSD !== undefined ? formatUSD(cost.totalUSD) : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default px-1 font-mono text-[11px] text-muted-foreground tabular-nums transition-colors hover:text-foreground">
          {summary}
        </span>
      </TooltipTrigger>
      <TooltipContent align="start" className="font-mono text-xs">
        <p className="mb-1.5 font-sans opacity-60">Thread total</p>
        <table className="tabular-nums">
          <tbody>
            {rows.map(([label, tokens, usd]) => (
              <tr key={label}>
                <td className="pr-3">{label}</td>
                <td className="pr-3 text-right">{formatTokens(tokens)}</td>
                <td className="text-right">
                  {usd !== undefined ? formatUSD(usd) : ""}
                </td>
              </tr>
            ))}
            <tr className="border-t border-current/20">
              <td className="pt-1 pr-3">Total</td>
              <td className="pt-1 pr-3 text-right">{formatTokens(total)}</td>
              <td className="pt-1 text-right">
                {cost?.totalUSD !== undefined ? formatUSD(cost.totalUSD) : ""}
              </td>
            </tr>
          </tbody>
        </table>
        {/* Nothing to say when the price is shown — it's already there, and
            it's the selected model's, which the selector next to this badge
            names. Only the reasons a price is MISSING need words. */}
        {!cost && (
          <p className="mt-1.5 font-sans opacity-60">
            {!pricingSupported
              ? "Restart demio to price this thread"
              : threadModelIds.length > 1
                ? "No cost — thread ran on several models"
                : !ranOnSelectedModel
                  ? "No cost — thread ran on a different model"
                  : "Price unavailable"}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
