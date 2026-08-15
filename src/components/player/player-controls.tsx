import {
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { PlayerScrubber } from "./player-scrubber"
import { formatTime } from "./player-utils"
import type { VideoPlayerApi } from "./use-video-player"

interface PlayerControlsProps {
  player: VideoPlayerApi
  isFullscreen: boolean
  onToggleFullscreen: () => void
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:outline-none"
    >
      {children}
    </button>
  )
}

export function PlayerControls({
  player,
  isFullscreen,
  onToggleFullscreen,
}: PlayerControlsProps) {
  const {
    playing,
    ended,
    duration,
    uiTime,
    seekable,
    volume,
    muted,
    togglePlay,
    setVolume,
    toggleMute,
    scrubberRef,
    bufferedFillRef,
    onScrubStart,
    onScrubInput,
  } = player

  return (
    <div className="flex flex-col gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-3 pt-6 pb-2">
      <PlayerScrubber
        scrubberRef={scrubberRef}
        bufferedFillRef={bufferedFillRef}
        duration={duration}
        disabled={!seekable}
        onScrubStart={onScrubStart}
        onScrubInput={onScrubInput}
      />

      <div className="flex items-center gap-1.5">
        <IconButton
          label={ended ? "Replay" : playing ? "Pause" : "Play"}
          onClick={togglePlay}
        >
          {ended ? (
            <RotateCcw className="size-4" />
          ) : playing ? (
            <Pause className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
        </IconButton>

        <IconButton label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
          {muted || volume === 0 ? (
            <VolumeX className="size-4" />
          ) : (
            <Volume2 className="size-4" />
          )}
        </IconButton>

        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          aria-label="Volume"
          onChange={(e) => setVolume(Number(e.currentTarget.value))}
          className={cn(
            "h-1 w-16 cursor-pointer appearance-none rounded-full bg-white/20",
            "[&::-webkit-slider-thumb]:size-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
          )}
        />

        <span className="ml-1 font-mono text-[11px] text-white/70 tabular-nums">
          {formatTime(uiTime)} / {seekable ? formatTime(duration) : "--:--"}
        </span>

        <div className="flex-1" />

        <IconButton
          label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? (
            <Minimize className="size-4" />
          ) : (
            <Maximize className="size-4" />
          )}
        </IconButton>
      </div>
    </div>
  )
}
