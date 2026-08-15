// ── demio-file:// protocol handler ──────────────────────────────────────────
//
// Serves local media files to the renderer with correct HTTP Range semantics.
//
// Three things here are load-bearing and easy to regress:
//
//   1. Aborts MUST destroy the read stream. Chromium's media stack always
//      abandons the initial open-ended request once it has buffered ahead,
//      then opens a fresh ranged one. Leaking those streams stalls playback
//      a few seconds in and leaks a file descriptor per request.
//   2. Suffix ranges (`bytes=-N`) mean the LAST N bytes. Treating them as
//      "from byte 0" hands the player the wrong data and breaks seeking.
//   3. Only paths published via `allowMediaPath` are servable. Without the
//      allowlist any renderer script could read any user-readable file.
//
// URL construction and the allowlist live in `./demio-file-url` — see the
// note there for why the split exists.

import { protocol } from "electron"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as NodeReadableStream } from "stream/web"
import log from "../lib/logger"
import {
  DEMIO_FILE_SCHEME,
  isMediaPathAllowed,
  mimeForPath,
  parseRange,
} from "./demio-file-url"

function errorResponse(status: number, message: string) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  })
}

export function registerDemioFileProtocol() {
  protocol.handle(DEMIO_FILE_SCHEME, async (req) => {
    let filePath: string
    try {
      const src = new URL(req.url).searchParams.get("src")
      if (!src) return errorResponse(400, "missing src")
      filePath = path.resolve(src)
    } catch (error) {
      log.warn(`[demio-file] bad url ${req.url}`, error)
      return errorResponse(400, "bad url")
    }

    if (!isMediaPathAllowed(filePath)) {
      log.warn(`[demio-file] refused (not published): ${filePath}`)
      return errorResponse(403, "not permitted")
    }

    let size: number
    try {
      const stats = await stat(filePath)
      if (!stats.isFile()) return errorResponse(404, "not a file")
      size = stats.size
    } catch (error) {
      log.warn(`[demio-file] stat failed ${filePath}`, error)
      return errorResponse(404, "not found")
    }

    const baseHeaders: Record<string, string> = {
      "Content-Type": mimeForPath(filePath),
      "Accept-Ranges": "bytes",
      // The URL already carries the file's mtime+size, so a given URL always
      // means the same bytes — that versioning IS the cache invalidation.
      //
      // Do NOT put `no-store` here. It forces the media stack to re-request
      // everything it already had, and a replay (or a seek back) then depends
      // on a fresh read succeeding instead of reusing the buffer it holds.
      "Cache-Control": "private, max-age=31536000, immutable",
    }

    const rangeHeader = req.headers.get("range")
    const range = rangeHeader ? parseRange(rangeHeader, size) : null

    if (range === "unsatisfiable") {
      log.debug(`[demio-file] 416 ${rangeHeader} size=${size}`)
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      })
    }

    const start = range ? range.start : 0
    const end = range ? range.end : Math.max(0, size - 1)
    const length = size === 0 ? 0 : end - start + 1

    try {
      // Read the exact byte range ourselves.
      //
      // Delegating the body to `net.fetch(file://…)` looks tempting, but its
      // file loader answers a ranged request with a bare 200 and no
      // Content-Range, so the length we advertise and the length we actually
      // send can disagree — and a Content-Length that doesn't match the body
      // is a fatal protocol error, surfacing as MEDIA_ERR_NETWORK. A read
      // stream gives a byte-exact range we can describe honestly.
      const stream = createReadStream(filePath, { start, end })

      // Chromium abandons requests as soon as it has buffered ahead; without
      // this the descriptor is never released.
      const onAbort = () => stream.destroy()
      req.signal.addEventListener("abort", onAbort, { once: true })
      stream.once("close", () =>
        req.signal.removeEventListener("abort", onAbort)
      )
      stream.on("error", (error: NodeJS.ErrnoException) => {
        // Cancellation arrives here on every seek — not worth a warning.
        const cancelled =
          error.name === "AbortError" ||
          error.code === "ERR_STREAM_PREMATURE_CLOSE"
        if (cancelled) {
          log.debug(`[demio-file] cancelled ${path.basename(filePath)}`)
        } else {
          log.warn(`[demio-file] stream error ${filePath}`, error)
        }
        stream.destroy()
      })

      const headers: Record<string, string> = {
        ...baseHeaders,
        "Content-Length": String(length),
      }
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`

      log.debug(
        `[demio-file] ${range ? 206 : 200} ${start}-${end}/${size} ` +
          `len=${length} ${path.basename(filePath)}`
      )

      return new Response(
        Readable.toWeb(stream) as unknown as NodeReadableStream,
        { status: range ? 206 : 200, headers }
      )
    } catch (error) {
      log.warn(`[demio-file] read failed ${filePath}`, error)
      return errorResponse(500, "read failed")
    }
  })
}
