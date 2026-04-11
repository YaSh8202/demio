/**
 * LiveBrowserView — Canvas component that renders the agent-browser
 * WebSocket stream as a live preview of the controlled Chrome viewport.
 *
 * Reusable: designed to be embedded in any layout (stream page, project page, etc.)
 *
 * Props:
 * - `wsUrl`: WebSocket URL to connect to (null = show placeholder)
 * - `className`: additional CSS classes for the outer container
 */

import { useEffect, useRef, useState, useCallback } from "react"
import { BrowserStream } from "@/lib/agent-browser/stream"
import type { StreamStatus } from "@/lib/agent-browser/stream"
import { cn } from "@/lib/utils"

interface LiveBrowserViewProps {
  wsUrl: string | null
  className?: string
}

export function LiveBrowserView({ wsUrl, className }: LiveBrowserViewProps) {
  // When wsUrl is null, show idle placeholder.
  // When wsUrl is set, render the StreamCanvas keyed by the URL
  // so React naturally resets all state on URL change.
  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-lg bg-neutral-900",
        className
      )}
    >
      {wsUrl ? <StreamCanvas key={wsUrl} wsUrl={wsUrl} /> : <Placeholder />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// StreamCanvas — handles the WebSocket connection and canvas rendering
// ---------------------------------------------------------------------------

function StreamCanvas({ wsUrl }: { wsUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<BrowserStream | null>(null)
  const rafRef = useRef<number | null>(null)

  const [status, setStatus] = useState<StreamStatus>("connecting")
  const [viewportWidth, setViewportWidth] = useState(1280)
  const [viewportHeight, setViewportHeight] = useState(720)
  const [hasReceivedFrame, setHasReceivedFrame] = useState(false)

  // Pending frame — written by onFrame callback, consumed by rAF loop
  const pendingFrameRef = useRef<HTMLImageElement | null>(null)

  // ---------------------------------------------------------------------------
  // Canvas sizing — maintain viewport aspect ratio within container
  // ---------------------------------------------------------------------------

  const updateCanvasSize = useCallback(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const containerW = container.clientWidth
    const containerH = container.clientHeight
    if (containerW === 0 || containerH === 0) return

    const aspectRatio = viewportWidth / viewportHeight
    let drawW: number
    let drawH: number

    if (containerW / containerH > aspectRatio) {
      // Container is wider than viewport ratio — fit to height
      drawH = containerH
      drawW = drawH * aspectRatio
    } else {
      // Container is taller — fit to width
      drawW = containerW
      drawH = drawW / aspectRatio
    }

    // Use device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(drawW * dpr)
    canvas.height = Math.round(drawH * dpr)
    canvas.style.width = `${Math.round(drawW)}px`
    canvas.style.height = `${Math.round(drawH)}px`

    const ctx = canvas.getContext("2d")
    if (ctx) {
      ctx.scale(dpr, dpr)
    }
  }, [viewportWidth, viewportHeight])

  // ResizeObserver for container size changes
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      updateCanvasSize()
    })
    observer.observe(container)
    updateCanvasSize()

    return () => observer.disconnect()
  }, [updateCanvasSize])

  // ---------------------------------------------------------------------------
  // rAF render loop — draws pending frames to canvas
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let running = true

    const drawLoop = () => {
      if (!running) return

      const img = pendingFrameRef.current
      if (img) {
        pendingFrameRef.current = null

        const ctx = canvas.getContext("2d")
        if (ctx) {
          const dpr = window.devicePixelRatio || 1
          const drawW = canvas.width / dpr
          const drawH = canvas.height / dpr
          ctx.clearRect(0, 0, drawW, drawH)
          ctx.drawImage(img, 0, 0, drawW, drawH)
        }
      }

      rafRef.current = requestAnimationFrame(drawLoop)
    }

    rafRef.current = requestAnimationFrame(drawLoop)

    return () => {
      running = false
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  // ---------------------------------------------------------------------------
  // BrowserStream lifecycle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const stream = new BrowserStream()
    streamRef.current = stream

    const unsubStatus = stream.onStatus(setStatus)

    const unsubViewport = stream.onViewportChange((w, h) => {
      setViewportWidth(w)
      setViewportHeight(h)
    })

    const unsubFrame = stream.onFrame((img) => {
      pendingFrameRef.current = img
      setHasReceivedFrame(true)
    })

    stream.connect(wsUrl)

    return () => {
      unsubStatus()
      unsubViewport()
      unsubFrame()
      stream.disconnect()
      streamRef.current = null
    }
  }, [wsUrl])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex items-center justify-center"
    >
      {/* Canvas for frame rendering */}
      <canvas
        ref={canvasRef}
        className={cn(
          "rounded transition-opacity duration-200",
          hasReceivedFrame ? "opacity-100" : "opacity-0"
        )}
      />

      {/* Live badge */}
      {status === "live" && hasReceivedFrame && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white backdrop-blur-sm">
          <span className="h-2 w-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]" />
          Live
        </div>
      )}

      {/* Connecting spinner */}
      {status === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-300" />
            <span className="text-sm text-neutral-400">Connecting...</span>
          </div>
        </div>
      )}

      {/* Reconnecting spinner */}
      {status === "disconnected" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-300" />
            <span className="text-sm text-neutral-400">Reconnecting...</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Placeholder — shown when no wsUrl is provided
// ---------------------------------------------------------------------------

function Placeholder() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
      <svg
        className="h-12 w-12 text-neutral-600"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25A2.25 2.25 0 0 1 5.25 3h13.5A2.25 2.25 0 0 1 21 5.25Z"
        />
      </svg>
      <span className="text-sm text-neutral-500">No browser session</span>
      <span className="text-xs text-neutral-600">
        Open a URL to see live preview
      </span>
    </div>
  )
}
