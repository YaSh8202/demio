// ── ffmpeg binary resolution + image helpers ─────────────────────────────────
//
// `ffmpeg-static` resolves its binary relative to its own `__dirname`. Vite
// bundles the package into `.vite/build/main-*.js` (it is not listed in
// `vite.main.config.ts` `external`), so at dev time that `__dirname` collapses
// to `.vite/build/` and the exported path points at a file that was never
// there — the cause of `[terminal] ffmpeg binary missing at …/.vite/build/ffmpeg`.
//
// Packaged builds ship the binary via `extraResource` (see `forge.config.ts`),
// so those resolve against `process.resourcesPath` instead. This module is the
// single place that knows both layouts.

import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { app } from "electron"
import ffmpegPath from "ffmpeg-static"
import log from "./logger"

/**
 * Absolute path to a usable ffmpeg binary, or `null` if none exists.
 */
export function resolveFfmpeg(): string | null {
  const candidates: string[] = []

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, "ffmpeg"))
  } else {
    // Real on-disk location. Both roots are checked because the app path and
    // the working directory can differ depending on how Electron was launched.
    for (const root of [app.getAppPath(), process.cwd()]) {
      candidates.push(
        path.join(root, "node_modules", "ffmpeg-static", "ffmpeg")
      )
    }
  }

  // Whatever the package itself reports — correct when running unbundled.
  if (ffmpegPath) candidates.push(ffmpegPath)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// ── Image downscaling ────────────────────────────────────────────────────────
//
// Screenshots go into the model context base64-encoded (~4/3 inflation) and stay
// there for every subsequent step of the turn, so one oversized full-page PNG can
// push request bodies into the megabytes. Rather than refusing to read it, shrink
// it: the agent almost always wants to *see* the page, not inspect pixels.

/** Width/quality ladder, tried in order until the result fits the budget. */
const DOWNSCALE_STEPS = [
  { width: 1568, quality: 5 },
  { width: 1024, quality: 6 },
  { width: 768, quality: 8 },
]

export interface DownscaledImage {
  data: Buffer
  mimeType: string
  /** Human-readable note describing what was done, for the agent's benefit. */
  note: string
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * Re-encode an image as JPEG, shrinking until it fits `maxBytes`.
 *
 * Returns `null` when ffmpeg is unavailable or every step still overshoots —
 * callers should treat that as "could not shrink" and surface their own error.
 * `-vf scale='min(W,iw)':-2` never upscales and keeps the aspect ratio with an
 * even height (required by the JPEG encoder).
 */
export async function downscaleImage(
  absPath: string,
  maxBytes: number
): Promise<DownscaledImage | null> {
  const bin = resolveFfmpeg()
  if (!bin) {
    log.warn("[ffmpeg] cannot downscale image — no ffmpeg binary available")
    return null
  }

  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "demio-img-"))
  try {
    for (const { width, quality } of DOWNSCALE_STEPS) {
      const outPath = path.join(tmpDir, `scaled-${width}.jpg`)
      try {
        await runFfmpeg(bin, [
          "-y",
          "-loglevel",
          "error",
          "-i",
          absPath,
          "-vf",
          `scale='min(${width},iw)':-2`,
          "-q:v",
          String(quality),
          outPath,
        ])
      } catch (err) {
        log.warn(`[ffmpeg] downscale to ${width}px failed:`, err)
        continue
      }

      const { size } = await fsPromises.stat(outPath)
      if (size > maxBytes) continue

      return {
        data: await fsPromises.readFile(outPath),
        mimeType: "image/jpeg",
        note: `Image was ${Math.round(
          (await fsPromises.stat(absPath)).size / 1024
        )}KB — automatically downscaled to ${width}px wide JPEG (${Math.round(
          size / 1024
        )}KB) to keep the request small. Re-read the original file only if you need exact pixels.`,
      }
    }
    return null
  } finally {
    await fsPromises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {})
  }
}
