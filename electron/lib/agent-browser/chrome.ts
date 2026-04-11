/**
 * Chrome detection and installation for agent-browser.
 *
 * agent-browser needs Chrome/Chromium to operate. This module
 * detects whether a compatible browser is available and handles
 * the `agent-browser install` flow to download one.
 */

import { execAgentBrowser } from "./exec"
import type { ExecOptions } from "./exec"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChromeStatus {
  /** Whether a compatible Chrome/Chromium is available. */
  available: boolean
  /** Version string if detected (e.g. "agent-browser 0.25.3"). */
  version?: string
  /** Error message if detection failed. */
  error?: string
}

export interface InstallResult {
  /** Whether the install completed successfully. */
  ok: boolean
  /** Final output or error message. */
  message: string
}

// ---------------------------------------------------------------------------
// Chrome detection
// ---------------------------------------------------------------------------

/**
 * Check if Chrome is available for agent-browser.
 *
 * Runs `agent-browser --version` to verify the binary works and
 * can find a Chrome installation.
 */
export async function checkChrome(): Promise<ChromeStatus> {
  try {
    const result = await execAgentBrowser(["--version"], { timeout: 10_000 })

    if (result.ok) {
      const version =
        typeof result.output === "string" ? result.output.trim() : ""
      return {
        available: true,
        version: version || undefined,
      }
    }

    // Command ran but failed — likely Chrome not found
    return {
      available: false,
      error: result.error || "agent-browser returned a non-zero exit code",
    }
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome installation
// ---------------------------------------------------------------------------

/**
 * Install Chrome for use with agent-browser.
 *
 * Spawns `agent-browser install` which downloads a compatible
 * Chrome/Chromium binary. Supports progress streaming via options.
 *
 * @param onProgress Optional callback invoked with each stdout line
 *   during the download (useful for progress UI).
 */
export async function installChrome(
  onProgress?: (line: string) => void
): Promise<InstallResult> {
  const options: ExecOptions = {
    // Chrome install can take a while on slow connections
    timeout: 300_000,
    onStdout: onProgress,
    onStderr: onProgress,
  }

  try {
    const result = await execAgentBrowser(["install"], options)

    if (result.ok) {
      return {
        ok: true,
        message:
          typeof result.output === "string"
            ? result.output.trim()
            : "Chrome installed successfully",
      }
    }

    return {
      ok: false,
      message: result.error || "Chrome installation failed",
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
