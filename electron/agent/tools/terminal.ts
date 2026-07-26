// ── Terminal Tool ────────────────────────────────────────────────────────────
//
// A single general-purpose shell tool. The agent uses this for:
//   - agent-browser CLI calls (navigate, snapshot, screenshot, record, …)
//   - shell file I/O (mkdir, ls, cat > file <<'EOF' …)
//   - ffmpeg for scene composition
//
// We spawn `sh -c <command>` (or `cmd /c` on Windows) with:
//   - cwd = the thread's workspace directory
//   - PATH prepended with a shim dir containing `agent-browser` + `ffmpeg`
//     symlinks / copies pointing at the bundled binaries
//
// Output is captured, truncated at ~20KB, and returned as a structured result.

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { app } from "electron"
import { tool } from "ai"
import { z } from "zod"
import { resolveFfmpeg } from "../../lib/ffmpeg"
import log from "../../lib/logger"
import { resolveBinaryPath as resolveAgentBrowser } from "../../lib/agent-browser/exec"

// ── Shim directory (PATH prepend target) ────────────────────────────────────

let cachedShimDir: string | null = null

/**
 * Create a directory containing executable aliases for `agent-browser` and
 * `ffmpeg`, then prepend it to PATH when spawning child shells.
 *
 * We use hardlinks on POSIX (falling back to symlinks, then file copies) and
 * `.cmd` stub files on Windows.
 */
function ensureShimDir(): string {
  if (cachedShimDir) return cachedShimDir

  const shimDir = path.join(app.getPath("userData"), "bin")
  fs.mkdirSync(shimDir, { recursive: true })

  const isWin = process.platform === "win32"

  // agent-browser
  try {
    const abTarget = resolveAgentBrowser()
    linkExe(shimDir, "agent-browser", abTarget, isWin)
  } catch (err) {
    log.error("[terminal] Failed to shim agent-browser:", err)
  }

  // ffmpeg
  const ffTarget = resolveFfmpeg()
  if (ffTarget) {
    linkExe(shimDir, "ffmpeg", ffTarget, isWin)
  } else {
    log.error(
      "[terminal] no ffmpeg binary found — video composition will fail. " +
        "Expected node_modules/ffmpeg-static/ffmpeg (dev) or resources/ffmpeg (packaged)."
    )
  }

  cachedShimDir = shimDir
  return shimDir
}

function linkExe(
  shimDir: string,
  name: string,
  target: string,
  isWin: boolean
): void {
  const dest = path.join(shimDir, isWin ? `${name}.cmd` : name)
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest)
  } catch {
    /* ignore */
  }
  try {
    if (isWin) {
      fs.writeFileSync(dest, `@echo off\r\n"${target}" %*\r\n`)
    } else {
      // Prefer symlink for transparency; fall back to hardlink then copy.
      try {
        fs.symlinkSync(target, dest)
      } catch {
        try {
          fs.linkSync(target, dest)
        } catch {
          fs.copyFileSync(target, dest)
        }
      }
      fs.chmodSync(dest, 0o755)
    }
  } catch (err) {
    log.error(`[terminal] Failed to create shim ${dest}:`, err)
  }
}

// ── Action-log path extraction ──────────────────────────────────────────────

/**
 * Find action-log JSONL files that were touched while the command was
 * running. Looks under `<workspace>/scenes/` for `*.actions.jsonl` files with
 * mtime ≥ startMs. Handles both direct `--log-actions` invocations and the
 * common case where the flag lives inside a scene `.sh` script.
 */
function findRecentActionLogs(workspace: string, startMs: number): string[] {
  const dir = path.join(workspace, "scenes")
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (!name.endsWith(".actions.jsonl")) continue
    const full = path.join(dir, name)
    try {
      const stat = fs.statSync(full)
      if (stat.mtimeMs >= startMs - 1000) out.push(full)
    } catch {
      /* ignore */
    }
  }
  return out
}

// ── Output truncation ───────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 20_000

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT_BYTES) return { text: s, truncated: false }
  return {
    text:
      s.slice(0, MAX_OUTPUT_BYTES) +
      `\n… [truncated ${s.length - MAX_OUTPUT_BYTES} chars]`,
    truncated: true,
  }
}

// ── Tool factory ────────────────────────────────────────────────────────────

export interface TerminalToolOptions {
  cwd: string
  signal: AbortSignal
}

const TOOL_DESCRIPTION = `Run a shell command inside the current thread's workspace directory.

Working directory ($WORKSPACE) is automatically set to the thread's workspace — always use workspace-relative paths. The workspace pre-contains: discovery/, scenes/, output/. Write files here freely (brief.md, script.md, etc.).

Every call must include a \`description\`: a clear 5-10 word summary of what the command does. This text is shown in the chat UI as the terminal card title.

Use this tool for THREE kinds of work:

1. Browser automation via \`agent-browser\` (on PATH):
   - \`agent-browser open <url>\`
   - \`agent-browser snapshot -i\`
   - \`agent-browser screenshot --screenshot-dir ./discovery --full\`
   - \`agent-browser record start ./scenes/scene-01.webm\` … \`agent-browser record stop\`
   - \`agent-browser batch "cmd1" "cmd2"\` for chained actions
   - \`agent-browser close\` when done. See the system prompt for full usage.

2. Shell utilities (NOT file read/write — use the \`read\`/\`edit\` tools for that):
   - Directory ops: \`mkdir -p discovery/\`, \`ls -la\`
   - Move/delete: \`mv\`, \`rm\`

3. Video composition via \`ffmpeg\` (on PATH):
   - Build concat list: \`printf "file './scenes/scene-01.webm'\\nfile './scenes/scene-02.webm'\\n" > scenes/list.txt\`
   - Concat: \`ffmpeg -y -f concat -safe 0 -i scenes/list.txt -c:v libx264 -pix_fmt yuv420p output/demo.mp4\`

Stdout is capped at 20KB — if output is truncated, narrow your query or pipe to a file.`

export function createTerminalTool({ cwd, signal }: TerminalToolOptions) {
  const shimDir = ensureShimDir()
  const pathSep = process.platform === "win32" ? ";" : ":"
  const injectedPath = `${shimDir}${pathSep}${process.env.PATH ?? ""}`

  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({
      command: z
        .string()
        .describe("Shell command to execute. Runs in `sh -c`."),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'"
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe(
          "Timeout in ms (default 120000, max 600000). Increase for long recordings or ffmpeg renders."
        ),
    }),
    execute: async (input) => {
      const { command, timeoutMs } = input
      const start = Date.now()
      const timeout = timeoutMs ?? 120_000

      return new Promise<{
        ok: boolean
        stdout: string
        stderr: string
        exitCode: number
        durationMs: number
        truncated: boolean
        agentBrowserErrors?: string[]
        aborted?: boolean
        timedOut?: boolean
      }>((resolve) => {
        const isWin = process.platform === "win32"
        const shell = isWin ? "cmd" : "sh"
        const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command]

        let child: ChildProcess
        try {
          child = spawn(shell, args, {
            cwd,
            env: { ...process.env, PATH: injectedPath, WORKSPACE: cwd },
            stdio: ["ignore", "pipe", "pipe"],
          })
        } catch (err) {
          resolve({
            ok: false,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            exitCode: -1,
            durationMs: Date.now() - start,
            truncated: false,
          })
          return
        }

        const stdoutChunks: string[] = []
        const stderrChunks: string[] = []
        let stdoutLen = 0
        let stderrLen = 0

        child.stdout?.on("data", (buf: Buffer) => {
          if (stdoutLen < MAX_OUTPUT_BYTES * 2) {
            stdoutChunks.push(buf.toString())
            stdoutLen += buf.length
          }
        })
        child.stderr?.on("data", (buf: Buffer) => {
          if (stderrLen < MAX_OUTPUT_BYTES * 2) {
            stderrChunks.push(buf.toString())
            stderrLen += buf.length
          }
        })

        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGTERM")
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL")
          }, 2000)
        }, timeout)

        let aborted = false
        const onAbort = () => {
          aborted = true
          child.kill("SIGTERM")
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL")
          }, 2000)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })

        child.on("close", (code) => {
          clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)

          const rawStdout = stdoutChunks.join("")
          const rawStderr = stderrChunks.join("")
          const outT = truncate(rawStdout)
          const errT = truncate(rawStderr)

          // Detect agent-browser error lines (e.g. "✗ Unknown ref: e7") that
          // exit with code 0 — treat them as failures so the LLM can react.
          const agentBrowserErrors = rawStdout
            .split("\n")
            .filter((line) => line.trimStart().startsWith("✗ "))
            .map((line) => line.trim())

          // Pull failed actions out of any action-log JSONL files that
          // agent-browser wrote during this command. Catches scene scripts
          // that invoked `record start --log-actions …` from a `.sh` file —
          // the bash stdout would otherwise hide per-action failures.
          for (const resolved of findRecentActionLogs(cwd, start)) {
            try {
              const stat = fs.statSync(resolved)
              if (stat.size === 0 || stat.size > 200_000) continue
              const content = fs.readFileSync(resolved, "utf8")
              for (const line of content.split("\n")) {
                if (!line.trim()) continue
                try {
                  const entry = JSON.parse(line) as {
                    action?: string
                    args?: unknown
                    target?: { x?: number; y?: number }
                    tsMs?: number
                    ok?: boolean
                  }
                  if (entry.ok === false) {
                    const tx = entry.target?.x ?? "?"
                    const ty = entry.target?.y ?? "?"
                    const argStr = JSON.stringify(entry.args ?? {}).slice(
                      0,
                      120
                    )
                    agentBrowserErrors.push(
                      `✗ scene action failed: ${entry.action ?? "?"} target=(${tx},${ty}) tsMs=${entry.tsMs ?? "?"} args=${argStr}`
                    )
                  }
                } catch {
                  /* skip malformed line */
                }
              }
            } catch (err) {
              log.warn(`[terminal] could not read action log ${resolved}:`, err)
            }
          }

          resolve({
            ok:
              code === 0 &&
              !aborted &&
              !timedOut &&
              agentBrowserErrors.length === 0,
            stdout: outT.text,
            stderr: errT.text,
            exitCode: code ?? -1,
            durationMs: Date.now() - start,
            truncated: outT.truncated || errT.truncated,
            ...(agentBrowserErrors.length > 0 && { agentBrowserErrors }),
            ...(aborted && { aborted: true }),
            ...(timedOut && { timedOut: true }),
          })
        })

        child.on("error", (err) => {
          clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
          resolve({
            ok: false,
            stdout: "",
            stderr: err.message,
            exitCode: -1,
            durationMs: Date.now() - start,
            truncated: false,
          })
        })
      })
    },
  })
}
