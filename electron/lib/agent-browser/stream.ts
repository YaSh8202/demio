/**
 * Stream lifecycle management for agent-browser.
 *
 * Manages the WebSocket stream server that broadcasts live
 * viewport frames from the controlled Chrome instance.
 *
 * The stream server is started on app launch and stopped on quit.
 * Renderer processes connect to the WebSocket URL to receive frames.
 */

import log from "../logger"
import { execAgentBrowser } from "./exec"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamEnableResult {
  success: boolean
  data: { connected: boolean; enabled: boolean; port: number } | null
  error: string | null
}

interface StreamStatusResult {
  success: boolean
  data: {
    connected: boolean
    enabled: boolean
    port: number
    screencasting: boolean
  } | null
  error: string | null
}

interface StreamDisableResult {
  success: boolean
  data: { disabled: boolean } | null
  error: string | null
}

export interface StreamInfo {
  port: number
  wsUrl: string
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Cached stream URL from the last successful enable/status call. */
let currentStreamInfo: StreamInfo | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWsUrl(port: number): string {
  return `ws://127.0.0.1:${port}`
}

function parseJsonOutput(
  output: string | Record<string, unknown>
): Record<string, unknown> | null {
  if (typeof output === "object") return output
  try {
    return JSON.parse(output) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enable the agent-browser WebSocket stream server.
 *
 * Tries the preferred port first, then retries up to 10 consecutive ports
 * on conflict. Returns the stream info (port + wsUrl) on success.
 *
 * If streaming is already enabled, falls back to `getStreamStatus()`
 * to return the current stream info.
 */
export async function enableStream(
  preferredPort = 9223
): Promise<StreamInfo | null> {
  const maxRetries = 10

  for (let i = 0; i < maxRetries; i++) {
    const port = preferredPort + i
    const result = await execAgentBrowser(
      [`stream enable --port ${port} --json`],
      { timeout: 10_000 }
    )

    const parsed = parseJsonOutput(result.output) as StreamEnableResult | null
    if (!parsed) {
      log.warn("[stream] Failed to parse enable output:", result.output)
      continue
    }

    if (parsed.success && parsed.data) {
      const info: StreamInfo = {
        port: parsed.data.port,
        wsUrl: buildWsUrl(parsed.data.port),
      }
      currentStreamInfo = info
      log.log(`[stream] Enabled on ${info.wsUrl}`)
      return info
    }

    // Already enabled — get current status instead
    if (
      parsed.error &&
      parsed.error.toLowerCase().includes("already enabled")
    ) {
      log.log("[stream] Already enabled, fetching current status")
      return getStreamStatus()
    }

    // Port conflict — try next port
    if (parsed.error && parsed.error.toLowerCase().includes("port")) {
      log.log(`[stream] Port ${port} conflict, trying next`)
      continue
    }

    // Other error — log and try next
    log.warn(`[stream] Enable failed on port ${port}:`, parsed.error)
  }

  log.error(`[stream] Failed to enable after ${maxRetries} port attempts`)
  return null
}

/**
 * Disable the agent-browser WebSocket stream server.
 */
export async function disableStream(): Promise<void> {
  try {
    const result = await execAgentBrowser(["stream disable --json"], {
      timeout: 10_000,
    })

    const parsed = parseJsonOutput(result.output) as StreamDisableResult | null
    if (parsed?.success) {
      log.log("[stream] Disabled")
    } else {
      log.warn("[stream] Disable response:", result.output)
    }
  } catch (err) {
    log.warn("[stream] disableStream failed:", err)
  }

  currentStreamInfo = null
}

/**
 * Get the current stream status from agent-browser.
 *
 * Returns cached info if available, otherwise queries the CLI.
 */
export async function getStreamStatus(): Promise<StreamInfo | null> {
  // If we already know the URL, return it
  if (currentStreamInfo) return currentStreamInfo

  try {
    const result = await execAgentBrowser(["stream status --json"], {
      timeout: 10_000,
    })

    const parsed = parseJsonOutput(result.output) as StreamStatusResult | null
    if (parsed?.success && parsed.data?.enabled && parsed.data.port) {
      const info: StreamInfo = {
        port: parsed.data.port,
        wsUrl: buildWsUrl(parsed.data.port),
      }
      currentStreamInfo = info
      return info
    }
  } catch (err) {
    log.warn("[stream] getStreamStatus failed:", err)
  }

  return null
}

/**
 * Get the cached stream WebSocket URL.
 *
 * Returns null if streaming hasn't been enabled or was disabled.
 * Does not query the CLI — use `getStreamStatus()` for a fresh check.
 */
export function getStreamUrl(): string | null {
  return currentStreamInfo?.wsUrl ?? null
}

/**
 * Drop the cached stream info so the next status/URL query talks to the daemon.
 * Used when the renderer reports its WebSocket can no longer reach the server.
 */
export function invalidateStreamCache(): void {
  currentStreamInfo = null
}

/**
 * Force a fresh stream enable, bypassing the cache.
 *
 * Called when the renderer detects the WS server is gone (daemon was killed
 * by `agent-browser close --all`, crashed, or otherwise died). `enableStream`
 * spawns the daemon if needed and handles the "already enabled" path by
 * falling back to a status query, so this works whether the daemon is dead
 * or just lost its stream server.
 */
export async function refreshStream(): Promise<StreamInfo | null> {
  invalidateStreamCache()
  return enableStream()
}
