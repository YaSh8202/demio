// ── Demio Workspace factory (ADR-011) ───────────────────────────────────────
//
// Builds a Mastra Workspace per thread: local filesystem + sandbox rooted at
// the thread's ~/.demio/workspaces/<threadId> dir, with the agent-browser +
// ffmpeg PATH shim in the sandbox env (lifted from the deleted terminal tool).
// Core tools (execute_command, read_file, edit_file, grep, list_files) come
// from this primitive — demio no longer implements them.
//
// Reconciled against the installed @mastra/core@1.55.0 .d.ts (see
// .superpowers/sdd/2026-07-31-agent-harness-and-demo-workflow/
// agentcontroller-api-notes.md and task-3-report.md for the full deviation
// list):
//   - `LocalFilesystem` requires `basePath` (not `allowedPaths` alone) —
//     `node_modules/@mastra/core/dist/workspace/filesystem/local-filesystem.d.ts:17-20`.
//     `allowedPaths` are *additional* dirs beyond basePath, so we only add
//     os.tmpdir() there — cwd is already covered by basePath.
//   - `LocalSandbox` takes `workingDirectory`, not `cwd` —
//     `node_modules/@mastra/core/dist/workspace/sandbox/local-sandbox.d.ts:36-48`.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { app } from "electron"
import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
} from "@mastra/core/workspace"
import { resolveFfmpeg } from "../lib/ffmpeg"
import { resolveBinaryPath as resolveAgentBrowser } from "../lib/agent-browser/exec"
import log from "../lib/logger"
import { ensureWorkspace } from "./workspace"

// ── Shim directory (PATH prepend target) ────────────────────────────────────
//
// Moved verbatim from electron/agent/tools/terminal.ts (Task 3) — terminal.ts
// now imports buildShimPath() from here instead of building its own copy.

let cachedShimDir: string | null = null

/**
 * Create a directory containing executable aliases for `agent-browser` and
 * `ffmpeg`, then return it so callers can prepend it to PATH.
 *
 * We use hardlinks on POSIX (falling back to symlinks, then file copies) and
 * `.cmd` stub files on Windows.
 */
export function buildShimPath(): string {
  if (cachedShimDir) return cachedShimDir

  const shimDir = path.join(app.getPath("userData"), "bin")
  fs.mkdirSync(shimDir, { recursive: true })

  const isWin = process.platform === "win32"

  // agent-browser
  try {
    const abTarget = resolveAgentBrowser()
    linkExe(shimDir, "agent-browser", abTarget, isWin)
  } catch (err) {
    log.error("[workspace-factory] Failed to shim agent-browser:", err)
  }

  // ffmpeg
  const ffTarget = resolveFfmpeg()
  if (ffTarget) {
    linkExe(shimDir, "ffmpeg", ffTarget, isWin)
  } else {
    log.error(
      "[workspace-factory] no ffmpeg binary found — video composition will fail. " +
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
    log.error(`[workspace-factory] Failed to create shim ${dest}:`, err)
  }
}

// ── Workspace factory ────────────────────────────────────────────────────────

export function createDemioWorkspace(threadId: string): Workspace {
  const cwd = ensureWorkspace(threadId)
  const shimDir = buildShimPath()
  const pathSep = process.platform === "win32" ? ";" : ":"

  return new Workspace({
    // Stable id per thread — reuse preserves ProcessManager (background
    // processes) across turns.
    id: `demio-workspace-${threadId}`,
    filesystem: new LocalFilesystem({
      basePath: cwd,
      allowedPaths: [os.tmpdir()],
    }),
    sandbox: new LocalSandbox({
      workingDirectory: cwd,
      env: {
        PATH: `${shimDir}${pathSep}${process.env.PATH ?? ""}`,
        FORCE_COLOR: "1",
        CI: "true",
        NONINTERACTIVE: "1",
      },
    }),
  })
}
