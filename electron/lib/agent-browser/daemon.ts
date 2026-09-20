/**
 * Daemon lifecycle management for agent-browser.
 *
 * agent-browser runs a background daemon that persists between commands.
 * This module handles cleanup on app start (stale sessions from crashes)
 * and teardown on app quit.
 */

import log from "../logger"
import { execAgentBrowser } from "./exec"
import { liveSmokeLock } from "../smoke-lock"

/** Track whether we've already cleaned up stale sessions on this launch. */
let daemonInitialized = false

/**
 * Ensure the daemon environment is clean.
 *
 * Called on app start. Runs `close --all` to kill any stale sessions
 * from a previous unclean shutdown. The daemon itself auto-starts
 * on the next command, so we don't need to explicitly launch it.
 *
 * Safe to call multiple times — only runs cleanup once.
 */
export async function ensureDaemon(): Promise<void> {
  if (daemonInitialized) return
  daemonInitialized = true

  // `close --all` closes every session on the machine's one daemon — a
  // headless smoke run's included. Its sessions are not ours to clean up.
  const smoke = liveSmokeLock()
  if (smoke) {
    log.log(
      `[agent-browser] Smoke run ${smoke.runId} is live — skipping stale-session cleanup`
    )
    return
  }

  try {
    // Kill any stale sessions from a previous crash
    const result = await execAgentBrowser(["close --all"], { timeout: 10_000 })
    if (result.ok) {
      log.log("[agent-browser] Cleaned up stale sessions")
    } else {
      // This is expected on first launch (no daemon running)
      log.log(
        "[agent-browser] No stale sessions to clean (or daemon not running)"
      )
    }
  } catch (err) {
    // Binary might not be installed yet — that's fine at startup
    log.warn("[agent-browser] ensureDaemon failed:", err)
  }
}

/**
 * Stop the daemon and close all browser sessions.
 *
 * Called on app quit (`before-quit`). Ensures no orphaned Chrome
 * processes are left behind.
 */
export async function stopDaemon(): Promise<void> {
  if (liveSmokeLock()) return
  try {
    await execAgentBrowser(["close --all"], { timeout: 10_000 })
    log.log("[agent-browser] Daemon stopped, all sessions closed")
  } catch (err) {
    log.warn("[agent-browser] stopDaemon failed:", err)
  }
}

/**
 * Check if the daemon is responsive by running a lightweight command.
 *
 * Returns true if `agent-browser --version` succeeds.
 */
export async function isDaemonRunning(): Promise<boolean> {
  try {
    const result = await execAgentBrowser(["--version"], { timeout: 5_000 })
    return result.ok
  } catch {
    return false
  }
}
