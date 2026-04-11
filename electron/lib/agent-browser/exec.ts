/**
 * Core subprocess wrapper for agent-browser CLI.
 *
 * Spawns `agent-browser` as a child process, handles JSON parsing,
 * timeouts, error handling, and binary path resolution.
 */

import { spawn, execSync } from "child_process"
import { existsSync, accessSync, chmodSync, constants as fsConstants } from "fs"
import path from "path"
import os from "os"
import { app } from "electron"
import { buildArgv } from "./quote"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecResult {
  /** Whether the command succeeded (exit code 0). */
  ok: boolean
  /** Parsed JSON output or raw text. */
  output: string | Record<string, unknown>
  /** stderr output, if any. */
  error?: string
  /** Process exit code. */
  exitCode: number
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

export interface ExecOptions {
  /** Timeout in milliseconds. Defaults to 30_000. */
  timeout?: number
  /**
   * Callback for streaming stdout lines as they arrive.
   * Useful for long-running commands like `install`.
   */
  onStdout?: (line: string) => void
  /**
   * Callback for streaming stderr lines as they arrive.
   */
  onStderr?: (line: string) => void
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/** Cached binary path. Resolved once per app lifecycle. */
let cachedBinaryPath: string | null = null

/**
 * Get the platform-specific native binary filename.
 *
 * agent-browser ships native binaries named like:
 *   agent-browser-darwin-arm64
 *   agent-browser-linux-x64
 *   agent-browser-win32-x64.exe
 */
function getNativeBinaryName(): string {
  const p = os.platform()
  const a = os.arch()

  const osKey = p === "win32" ? "win32" : p === "darwin" ? "darwin" : "linux"
  const archKey = a === "arm64" ? "arm64" : "x64"
  const ext = p === "win32" ? ".exe" : ""

  return `agent-browser-${osKey}-${archKey}${ext}`
}

/**
 * Resolve the agent-browser binary path.
 *
 * In a packaged Electron app, the Vite plugin bundles main/preload/renderer
 * and does NOT include node_modules in the asar. The native binary is
 * shipped via `extraResource` in forge.config.ts, which places the
 * agent-browser `bin/` directory at `Resources/bin/` inside the app bundle.
 *
 * Check order:
 * 1. extraResource: process.resourcesPath/bin/<native-binary> (packaged)
 * 2. node_modules/agent-browser/bin/<native-binary> (dev)
 * 3. node_modules/.bin/agent-browser (dev fallback)
 * 4. System PATH
 *
 * Throws if binary cannot be found.
 */
export function resolveBinaryPath(): string {
  if (cachedBinaryPath) return cachedBinaryPath

  const nativeBin = getNativeBinaryName()
  const candidates: string[] = []

  if (app.isPackaged) {
    // Packaged: extraResource copies bin/ → Resources/bin/
    candidates.push(path.join(process.resourcesPath, "bin", nativeBin))
  } else {
    // Dev mode: resolve from project root
    const appRoot = app.getAppPath()
    candidates.push(
      path.join(appRoot, "node_modules", "agent-browser", "bin", nativeBin)
    )
    // Also check .bin symlink as fallback
    const binShim =
      process.platform === "win32" ? "agent-browser.cmd" : "agent-browser"
    candidates.push(path.join(appRoot, "node_modules", ".bin", binShim))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      // Ensure the binary is executable (bun skips postinstall by default)
      if (process.platform !== "win32") {
        try {
          accessSync(candidate, fsConstants.X_OK)
        } catch {
          try {
            chmodSync(candidate, 0o755)
          } catch {
            // If chmod fails, still try to use it
          }
        }
      }
      cachedBinaryPath = candidate
      return cachedBinaryPath
    }
  }

  // Fall back to system PATH
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which"
    const systemBin = execSync(`${whichCmd} agent-browser`, {
      encoding: "utf-8",
    }).trim()
    if (systemBin) {
      cachedBinaryPath = systemBin
      return cachedBinaryPath
    }
  } catch {
    // not on PATH
  }

  throw new Error(
    `agent-browser binary not found. Checked:\n${candidates.map((c) => `  ${c}`).join("\n")}\n  System PATH`
  )
}

/** Clear the cached binary path (for testing). */
export function clearBinaryCache(): void {
  cachedBinaryPath = null
}

// ---------------------------------------------------------------------------
// Core exec function
// ---------------------------------------------------------------------------

/**
 * Execute one or more agent-browser commands.
 *
 * - Single command: spawns `agent-browser <...args>`
 * - Multiple commands: spawns `agent-browser batch "cmd1" "cmd2" ...`
 *
 * When any command in `commands` contains `--json`, the stdout is
 * attempted to be parsed as JSON. Falls back to raw text on failure.
 */
export async function execAgentBrowser(
  commands: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const { timeout = 30_000, onStdout, onStderr } = options
  const binPath = resolveBinaryPath()
  const argv = buildArgv(commands)
  const start = Date.now()

  // Determine if we should attempt JSON parsing
  const wantsJson = commands.some((cmd) => cmd.includes("--json"))

  return new Promise<ExecResult>((resolve) => {
    const child = spawn(binPath, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      // Ensure the child inherits PATH for Chrome discovery
      env: { ...process.env },
    })

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString()
      stdoutChunks.push(text)
      if (onStdout) {
        // Split into lines and emit each
        const lines = text.split("\n")
        for (const line of lines) {
          if (line) onStdout(line)
        }
      }
    })

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString()
      stderrChunks.push(text)
      if (onStderr) {
        const lines = text.split("\n")
        for (const line of lines) {
          if (line) onStderr(line)
        }
      }
    })

    // Timeout handling
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      // Give it a moment to clean up, then force kill
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL")
      }, 2000)
    }, timeout)

    child.on("close", (code) => {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      const exitCode = code ?? 1
      const rawStdout = stdoutChunks.join("")
      const rawStderr = stderrChunks.join("")

      // Try JSON parsing if requested
      let output: string | Record<string, unknown> = rawStdout.trim()
      if (wantsJson && rawStdout.trim()) {
        try {
          output = JSON.parse(rawStdout.trim()) as Record<string, unknown>
        } catch {
          // Not valid JSON — keep as raw text
        }
      }

      resolve({
        ok: exitCode === 0,
        output,
        error: rawStderr.trim() || undefined,
        exitCode,
        durationMs,
      })
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      resolve({
        ok: false,
        output: "",
        error: err.message,
        exitCode: -1,
        durationMs,
      })
    })
  })
}
