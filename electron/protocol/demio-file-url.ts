// ── demio-file:// URL construction + allowlist ──────────────────────────────
//
// Split out from `demio-file.ts` deliberately: this module is reachable from
// `electron/handlers`, which `tsconfig.app.json` also compiles (with DOM libs
// and no node types). Keeping the `Response`/stream machinery out of here
// means the renderer-facing project never has to typecheck it.

import path from "node:path"

export const DEMIO_FILE_SCHEME = "demio-file"

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
}

export function mimeForPath(filePath: string): string {
  return (
    MIME_BY_EXT[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  )
}

/** Paths explicitly published for playback. Nothing else is servable. */
const allowedPaths = new Set<string>()

export function allowMediaPath(absPath: string) {
  allowedPaths.add(path.resolve(absPath))
}

export function isMediaPathAllowed(absPath: string): boolean {
  return allowedPaths.has(path.resolve(absPath))
}

/**
 * Build the URL the renderer plays.
 *
 * `version` (mtime+size) is what makes a regenerated file a genuinely
 * different URL, so the <video> element drops its stale buffer instead of
 * silently replaying the old bytes.
 */
export function toDemioFileUrl(absPath: string, version: string): string {
  const src = encodeURIComponent(path.resolve(absPath))
  return `${DEMIO_FILE_SCHEME}://media/?src=${src}&v=${encodeURIComponent(version)}`
}

export type ParsedRange =
  | { start: number; end: number }
  | "unsatisfiable"
  | null

/**
 * Parse a single RFC 7233 byte-range.
 *
 * Returns `null` when the header should be ignored (malformed, or a
 * multi-range request we don't serve) — answering those with a plain 200 is
 * legal and is what every media element falls back to.
 */
export function parseRange(header: string, size: number): ParsedRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === "" && rawEnd === "") return "unsatisfiable"
  if (size === 0) return "unsatisfiable"

  let start: number
  let end: number

  if (rawStart === "") {
    // Suffix form: `bytes=-N` is the LAST N bytes, not the first N.
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable"
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    if (!Number.isSafeInteger(start)) return "unsatisfiable"
    end = rawEnd === "" ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(end)) end = size - 1
    end = Math.min(end, size - 1)
  }

  if (start >= size || start > end) return "unsatisfiable"
  return { start, end }
}
