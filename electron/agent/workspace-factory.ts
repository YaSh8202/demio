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
import { userDataDir } from "../lib/electron-app"
import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
} from "@mastra/core/workspace"
import type { WorkspaceToolsConfig } from "@mastra/core/workspace"
import { resolveFfmpeg } from "../lib/ffmpeg"
import { resolveBinaryPath as resolveAgentBrowser } from "../lib/agent-browser/exec"
import log from "../lib/logger"
import { ensureWorkspace } from "./workspace"
import { sandboxEnv } from "./workflows/sandbox-env"

// ── Shim directory (PATH prepend target) ────────────────────────────────────
//
// Moved verbatim from electron/agent/tools/terminal.ts (Task 3) — terminal.ts
// now imports buildShimPath() from here instead of building its own copy.

/**
 * The inherited PATH minus every `node_modules/.bin`. Launching through
 * `bun start` puts the repo's own bin dir on PATH; left there it is both a
 * second, unintended `agent-browser` and a signpost to the source tree.
 */
function sandboxPath(inherited: string): string {
  const sep = process.platform === "win32" ? ";" : ":"
  return inherited
    .split(sep)
    .filter((dir) => dir && !/[\\/]node_modules[\\/]\.bin\/?$/.test(dir))
    .join(sep)
}

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

  const shimDir = path.join(userDataDir(), "bin")
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
    // `rmSync` + `force`, never `existsSync` then `unlinkSync`: `existsSync`
    // FOLLOWS symlinks, so a dangling one reads as "not there", survives,
    // and every later attempt then fails on it — symlink/link with EEXIST,
    // and `copyFile` by following the dead link to a directory that no
    // longer exists (the ENOENT this function logged for six weeks). That is
    // how both shims came to point into a deleted git worktree, the shim dir
    // silently stopped working, and the agent's shell fell through to
    // `node_modules/.bin/agent-browser` on the inherited PATH.
    fs.rmSync(dest, { force: true })
    if (!fs.existsSync(target)) {
      throw new Error(`target does not exist: ${target}`)
    }
    if (isWin) {
      fs.writeFileSync(dest, `@echo off\r\n"${target}" %*\r\n`)
    } else {
      // A wrapper script, not a symlink. `which agent-browser` on a symlink
      // resolves (via `readlink`/`realpath`) to the repo's node_modules —
      // which is exactly how a rehearsal agent found Demio's source tree and
      // spent a quarter of its step budget reading the linter it was being
      // checked by. A script's path is just the shim dir.
      const quoted = `'${target.replaceAll("'", "'\\''")}'`
      fs.writeFileSync(dest, `#!/bin/sh\nexec ${quoted} "$@"\n`, {
        mode: 0o755,
      })
      fs.chmodSync(dest, 0o755)
    }
  } catch (err) {
    log.error(`[workspace-factory] Failed to create shim ${dest}:`, err)
  }
}

// ── Workspace factory ────────────────────────────────────────────────────────

/**
 * Build a Workspace (filesystem + sandbox) rooted at an arbitrary directory.
 * `createDemioWorkspace` (below) is the thread-scoped convenience wrapper
 * used by the live chat AgentController; `createDemioAgent` (mastra.ts, Task
 * 11) calls this directly for the recorder/narrator agents, which are handed
 * an already-resolved workspace directory rather than a threadId.
 */
export function createWorkspaceForDir(
  cwd: string,
  opts?: { id?: string; tools?: WorkspaceToolsConfig }
): Workspace {
  const shimDir = buildShimPath()
  const pathSep = process.platform === "win32" ? ";" : ":"

  // Disable the BUILT-IN execute_command everywhere. Demio registers its own
  // tool under the same exposed name so the model has to pass a `description`
  // (the chat UI's "Shell" card title) — see
  // `electron/agent/tools/execute-command.ts`. Leaving both registered would
  // collide: workspace tools are spread LAST into the Agent's tool map, so the
  // built-in would silently win. This must be the last key in the object so it
  // beats any per-tool entry a caller passed in (per-tool config overrides the
  // top-level default, and later keys override earlier ones).
  const callerTools = (opts?.tools ?? {}) as Record<string, unknown>
  const callerExecConfig = callerTools["mastra_workspace_execute_command"]
  const tools = {
    ...callerTools,
    mastra_workspace_execute_command: {
      ...(typeof callerExecConfig === "object" && callerExecConfig !== null
        ? callerExecConfig
        : {}),
      enabled: false,
    },
  } as WorkspaceToolsConfig

  return new Workspace({
    id: opts?.id,
    filesystem: new LocalFilesystem({
      basePath: cwd,
      allowedPaths: [os.tmpdir()],
    }),
    sandbox: new LocalSandbox({
      workingDirectory: cwd,
      // `LocalSandboxOptions.env` is NOT merged with process.env by
      // LocalSandbox — only PATH is special-cased ("PATH is included by
      // default unless overridden"); every other host var is absent unless
      // listed here (local-sandbox.d.ts:38-48). Spread process.env first
      // (matching the old terminal.ts's `{ ...process.env, PATH, WORKSPACE }`
      // spawn env — agent-browser/Chromium need HOME, and shell tooling in
      // general expects a normal environment), then override the vars that
      // must differ from the host.
      // Allowlisted, not spread: `main.ts` loads `.env.local` into
      // `process.env`, so `{ ...process.env }` handed the agent's shell
      // every provider key in that file. See `sandbox-env-pure.cjs`.
      env: sandboxEnv(process.env, {
        PATH: `${shimDir}${pathSep}${sandboxPath(process.env.PATH ?? "")}`,
        WORKSPACE: cwd,
        FORCE_COLOR: "1",
        CI: "true",
        NONINTERACTIVE: "1",
      }),
    }),
    tools,
  })
}

/**
 * One Workspace instance per thread, cached.
 *
 * The cache is load-bearing now, not just an optimisation: the controller
 * hands the session a Workspace, while the `description`-carrying
 * execute_command replacement is registered as a plain agent tool and has to
 * be bound to a Workspace explicitly (assigned tools get no workspace in their
 * execution context). Both must resolve to the SAME instance or shell commands
 * would run against a second LocalSandbox with its own ProcessManager, leaving
 * `get_process_output`/`kill_process` unable to see the processes
 * execute_command spawned.
 *
 * Entries are held for the process lifetime unless `disposeDemioWorkspace` is
 * called — each one pins a `LocalSandbox` and its `ProcessManager`, so a
 * long-lived Electron session that opens many threads would otherwise
 * accumulate sandboxes (possibly still holding spawned background processes)
 * with nothing ever freeing them.
 */
const workspaceCache = new Map<string, Workspace>()

export function createDemioWorkspace(threadId: string): Workspace {
  const cached = workspaceCache.get(threadId)
  if (cached) return cached

  const cwd = ensureWorkspace(threadId)
  // Stable id per thread — reuse preserves ProcessManager (background
  // processes) across turns.
  const workspace = createWorkspaceForDir(cwd, {
    id: `demio-workspace-${threadId}`,
  })
  workspaceCache.set(threadId, workspace)
  return workspace
}

/**
 * Drop a thread's cached Workspace and tear down its sandbox.
 *
 * Call when a thread is gone for good (deleted, or its project deleted) —
 * `electron/agent/controller.ts`'s `disposeThread` is the single entry point,
 * so the cached `Session` is discarded alongside it. Destroying is
 * best-effort: a failure here must not block the delete the user asked for.
 */
export function disposeDemioWorkspace(threadId: string): void {
  const workspace = workspaceCache.get(threadId)
  if (!workspace) return

  workspaceCache.delete(threadId)
  workspace
    .destroy()
    .catch((err: unknown) =>
      log.error(
        `[workspace-factory] failed to destroy workspace for thread ${threadId}:`,
        err
      )
    )
}
