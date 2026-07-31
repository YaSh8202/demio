// ── Message Usage Badge ──────────────────────────────────────────────────────
//
// Tokens and USD for a single assistant turn, read off `message.metadata`.
//
// The main process attaches this twice: once on the live stream's `finish`
// chunk (so the numbers appear as the run lands) and again when the message is
// persisted. Both are the same figures — see `electron/agent/usage.ts`.

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { MessageMetadata } from "@electron/store/types"

/** Compact token count: 812, 1.2k, 148k. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
}

/**
 * USD at a precision that stays readable across four orders of magnitude —
 * a cheap turn costs $0.0004, an expensive one $2.15.
 */
function formatUSD(usd: number): string {
  if (usd === 0) return "$0"
  if (usd < 0.0001) return "<$0.0001"
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** True when there is anything worth rendering. */
export function hasUsage(metadata: MessageMetadata | undefined): boolean {
  const usage = metadata?.totalUsage
  if (!usage) return false
  return Boolean(usage.inputTokens || usage.outputTokens || usage.totalTokens)
}

export function MessageUsage({
  metadata,
}: {
  metadata: MessageMetadata | undefined
}) {
  if (!hasUsage(metadata) || !metadata) return null

  const usage = metadata.totalUsage!
  const cost = metadata.cost
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0
  const reasoning = usage.outputTokenDetails?.reasoningTokens ?? 0

  // Each row is [label, tokens, usd] — omitted entirely when the provider
  // didn't report that bucket, so a non-caching model shows no cache rows.
  const rows: Array<[string, number | undefined, number | undefined]> = [
    ["Input", usage.inputTokens, cost?.inputUSD],
    ["Output", usage.outputTokens, cost?.outputUSD],
  ]
  if (reasoning) rows.push(["Reasoning", reasoning, cost?.reasoningUSD])
  if (cacheRead) rows.push(["Cache read", cacheRead, cost?.cacheReadUSD])
  if (cacheWrite) rows.push(["Cache write", cacheWrite, cost?.cacheWriteUSD])

  const summary = [
    usage.inputTokens ? `${formatTokens(usage.inputTokens)} in` : null,
    usage.outputTokens ? `${formatTokens(usage.outputTokens)} out` : null,
    cost?.totalUSD !== undefined ? formatUSD(cost.totalUSD) : null,
  ].filter(Boolean)

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default font-mono text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground">
            {summary.join(" · ")}
          </span>
        </TooltipTrigger>
        <TooltipContent align="end" className="font-mono text-xs">
          <table className="tabular-nums">
            <tbody>
              {rows.map(([label, tokens, usd]) => (
                <tr key={label}>
                  <td className="pr-3">{label}</td>
                  <td className="pr-3 text-right">
                    {tokens ? formatTokens(tokens) : "—"}
                  </td>
                  <td className="text-right">
                    {usd !== undefined ? formatUSD(usd) : ""}
                  </td>
                </tr>
              ))}
              {usage.totalTokens ? (
                <tr className="border-t border-current/20">
                  <td className="pt-1 pr-3">Total</td>
                  <td className="pt-1 pr-3 text-right">
                    {formatTokens(usage.totalTokens)}
                  </td>
                  <td className="pt-1 text-right">
                    {cost?.totalUSD !== undefined
                      ? formatUSD(cost.totalUSD)
                      : ""}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {metadata.modelId ? (
            <p className="mt-1.5 opacity-60">{metadata.modelId}</p>
          ) : null}
          {!cost ? (
            <p className="mt-1.5 opacity-60">Price unavailable</p>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
