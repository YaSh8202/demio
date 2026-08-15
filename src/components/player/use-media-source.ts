import { useCallback, useEffect, useState } from "react"
import { apis } from "@/types/electron-api"

export type MediaSourceStatus = "idle" | "loading" | "ready" | "missing"

export interface MediaSource {
  url: string | null
  mime: string | null
  status: MediaSourceStatus
  /** Re-resolve from disk, picking up a fresh version token. */
  reload: () => void
}

interface Resolved {
  key: string
  url: string | null
  mime: string | null
}

/**
 * Resolve an absolute file path into a playable demio-file:// URL.
 *
 * The returned URL carries a `v=<mtime>-<size>` token, so a regenerated file
 * at the same path yields a different URL. That is what lets callers key the
 * <video> element on `url` and get a genuinely fresh element instead of one
 * still holding the previous file's buffer.
 *
 * `generation` exists because the path alone is not enough: regenerating
 * writes to the same path, so nothing about `filePath` changes and this hook
 * would never re-run. Callers bump it whenever the file may have changed.
 *
 * State is stamped with the request key it belongs to and everything else is
 * derived, so a result for a stale path can never be shown and the effect
 * never has to setState synchronously.
 */
export function useMediaSource(
  filePath: string | null,
  generation: string | number = 0
): MediaSource {
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [nonce, setNonce] = useState(0)

  const key = filePath ? `${generation}:${nonce}:${filePath}` : ""

  useEffect(() => {
    if (!filePath) return
    let cancelled = false

    apis?.media
      .resolve(filePath)
      .then((media) => {
        if (cancelled) return
        setResolved({
          key,
          url: media?.url ?? null,
          mime: media?.mime ?? null,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.error("[player] media.resolve failed", filePath, error)
        setResolved({ key, url: null, mime: null })
      })

    return () => {
      cancelled = true
    }
  }, [filePath, key])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const current = resolved?.key === key ? resolved : null
  const status: MediaSourceStatus = !filePath
    ? "idle"
    : !current
      ? "loading"
      : current.url
        ? "ready"
        : "missing"

  return {
    url: current?.url ?? null,
    mime: current?.mime ?? null,
    status,
    reload,
  }
}
