// ── Electron `app`, resolved lazily ─────────────────────────────────────────
//
// `import { app } from "electron"` fails at link time under plain Node, Bun
// or vitest: the `electron` npm package exports the binary's path, not the
// API. Three modules on the agent's dependency path used `app` only to find
// files (the userData dir, the app root, the packaged-or-not flag), and that
// single import made the whole agent — and any eval of it — unloadable
// outside the running app. Inside Electron, `require("electron")` is
// intercepted by the runtime and returns the real API regardless of what is
// in node_modules.
//
// Outside Electron every accessor returns what a checkout on disk means:
// not packaged, the working directory as the app root, `~/.demio` as the
// user-data root.

import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

function electronApp(): Electron.App | null {
  if (!process.versions.electron) return null
  return (require("electron") as typeof import("electron")).app
}

export function isPackaged(): boolean {
  return electronApp()?.isPackaged ?? false
}

export function appRoot(): string {
  return electronApp()?.getAppPath() ?? process.cwd()
}

export function userDataDir(): string {
  const app = electronApp()
  if (app) return app.getPath("userData")
  // Evals set this to a temp dir so the sandbox shim they build never lands
  // in the real user's directories.
  return process.env.DEMIO_USER_DATA_DIR ?? path.join(os.homedir(), ".demio")
}
