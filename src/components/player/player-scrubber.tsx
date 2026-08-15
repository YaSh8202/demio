import { cn } from "@/lib/utils"

interface PlayerScrubberProps {
  scrubberRef: React.RefObject<HTMLInputElement | null>
  bufferedFillRef: React.RefObject<HTMLDivElement | null>
  duration: number
  disabled: boolean
  onScrubStart: () => void
  onScrubInput: (time: number) => void
  className?: string
}

/**
 * Native range input rather than a controlled React slider.
 *
 * The playback loop writes `input.value` directly at 60fps, so the thumb
 * tracks playback without a single re-render. A controlled component would
 * mean setState per frame, which is exactly what this player avoids.
 */
export function PlayerScrubber({
  scrubberRef,
  bufferedFillRef,
  duration,
  disabled,
  onScrubStart,
  onScrubInput,
  className,
}: PlayerScrubberProps) {
  return (
    <div className={cn("group relative flex h-4 items-center", className)}>
      {/* track */}
      <div className="pointer-events-none absolute inset-x-0 h-1 overflow-hidden rounded-full bg-white/15">
        <div
          ref={bufferedFillRef}
          className="h-full w-full origin-left scale-x-0 bg-white/25"
        />
      </div>

      <input
        ref={scrubberRef}
        type="range"
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.01}
        defaultValue={0}
        disabled={disabled}
        aria-label="Seek"
        onPointerDown={onScrubStart}
        onKeyDown={onScrubStart}
        onChange={(e) => onScrubInput(Number(e.currentTarget.value))}
        className={cn(
          "relative h-1 w-full cursor-pointer appearance-none bg-transparent",
          "disabled:cursor-not-allowed disabled:opacity-40",
          // filled portion is drawn by the thumb's position over the track
          "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-transparent",
          "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white",
          "[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:shadow-sm",
          "[&::-webkit-slider-thumb]:transition-transform group-hover:[&::-webkit-slider-thumb]:scale-110"
        )}
      />
    </div>
  )
}
