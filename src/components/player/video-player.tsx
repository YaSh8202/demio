import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { SEEK_STEP_LARGE_S, SEEK_STEP_S, VOLUME_STEP } from "./constants"
import {
  PlayerEmpty,
  PlayerError,
  PlayerLoading,
  PlayerPlayBadge,
} from "./player-overlay"
import { PlayerControls } from "./player-controls"
import { isTextEntryTarget } from "./player-utils"
import { useMediaSource } from "./use-media-source"
import { useVideoPlayer } from "./use-video-player"

interface VideoPlayerProps {
  filePath: string | null
  /** Bump to force a re-resolve when the file at `filePath` was rewritten. */
  generation?: string | number
  className?: string
}

export function VideoPlayer({
  filePath,
  generation = 0,
  className,
}: VideoPlayerProps) {
  const source = useMediaSource(filePath, generation)
  const player = useVideoPlayer(source.url)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const { videoRef, seekBy, setVolume, toggleMute, togglePlay, volume } = player

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void container.requestFullscreen().catch(() => {})
  }, [])

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Never hijack the chat composer.
      if (isTextEntryTarget(e.target)) return

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault()
          togglePlay()
          break
        case "ArrowLeft":
          e.preventDefault()
          seekBy(e.shiftKey ? -SEEK_STEP_LARGE_S : -SEEK_STEP_S)
          break
        case "ArrowRight":
          e.preventDefault()
          seekBy(e.shiftKey ? SEEK_STEP_LARGE_S : SEEK_STEP_S)
          break
        case "j":
          e.preventDefault()
          seekBy(-SEEK_STEP_LARGE_S)
          break
        case "l":
          e.preventDefault()
          seekBy(SEEK_STEP_LARGE_S)
          break
        case "ArrowUp":
          e.preventDefault()
          setVolume(volume + VOLUME_STEP)
          break
        case "ArrowDown":
          e.preventDefault()
          setVolume(volume - VOLUME_STEP)
          break
        case "m":
          e.preventDefault()
          toggleMute()
          break
        case "f":
          e.preventDefault()
          toggleFullscreen()
          break
        default:
          break
      }
    },
    [togglePlay, seekBy, setVolume, toggleMute, toggleFullscreen, volume]
  )

  if (!filePath) return <PlayerEmpty />

  if (source.status === "missing") {
    return (
      <div className="relative size-full bg-black">
        <PlayerError
          message="Video file not found — it may still be rendering."
          onRetry={source.reload}
        />
      </div>
    )
  }

  const showPlayBadge =
    player.status === "ready" && !player.playing && !player.ended

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "group relative flex size-full flex-col justify-end overflow-hidden rounded-md bg-black focus-visible:outline-none",
        className
      )}
    >
      {source.url && (
        <video
          // A new URL means new bytes — remount so no stale buffer survives.
          key={source.url}
          ref={videoRef}
          src={source.url}
          preload="auto"
          playsInline
          // Deliberately no crossOrigin: on this opaque-origin custom scheme
          // it forces a CORS check the protocol handler cannot satisfy.
          onClick={togglePlay}
          className="absolute inset-0 size-full object-contain"
        />
      )}

      {source.status === "loading" && <PlayerLoading label="Loading video…" />}

      {player.status === "stalled" && <PlayerLoading label="Buffering…" />}

      {showPlayBadge && <PlayerPlayBadge onClick={togglePlay} />}

      {player.status === "error" && (
        <PlayerError
          message={player.errorText ?? "Something went wrong."}
          onRetry={source.reload}
        />
      )}

      <div className="relative opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[:focus-visible]:opacity-100">
        <PlayerControls
          player={player}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
        />
      </div>
    </div>
  )
}
