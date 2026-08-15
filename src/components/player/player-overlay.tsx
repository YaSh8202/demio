import { AlertTriangle, Loader2, Play } from "lucide-react"

export function PlayerLoading({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 text-center">
      <Loader2 className="size-5 animate-spin text-white/45" />
      <p className="text-[12px] text-white/60">{label}</p>
    </div>
  )
}

export function PlayerError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-8 text-center">
      <AlertTriangle className="size-5 text-amber-400/90" />
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-medium text-white/85">
          Can&apos;t play this video
        </p>
        <p className="max-w-[340px] text-[12px] leading-relaxed text-white/50">
          {message}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 rounded-md border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition-colors hover:bg-white/10"
      >
        Retry
      </button>
    </div>
  )
}

/** Big centre affordance shown while paused, so the panel reads as a player. */
export function PlayerPlayBadge({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Play"
      onClick={onClick}
      className="absolute inset-0 flex items-center justify-center focus-visible:outline-none"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm transition-transform hover:scale-105">
        <Play className="ml-0.5 size-6 text-white" />
      </span>
    </button>
  )
}

export function PlayerEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <Loader2 className="size-5 animate-spin text-white/45" />
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-medium text-white/85">
          Video not ready yet
        </p>
        <p className="max-w-[320px] text-[12px] leading-relaxed text-white/45">
          The agent is still recording and rendering. The preview will appear
          here automatically once it&apos;s done.
        </p>
      </div>
    </div>
  )
}
