/** `0:07` / `1:23:45`. Returns `--:--` for a duration we could not resolve. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--"
  const total = Math.floor(seconds)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * Best available duration.
 *
 * MediaRecorder-style WebM reports `Infinity` until it has been played
 * through, so fall back to the seekable range — which is often correct even
 * when `duration` is not. Returns 0 when nothing usable is available.
 */
export function resolveDuration(video: HTMLVideoElement): number {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration
  }
  if (video.seekable.length > 0) {
    const end = video.seekable.end(video.seekable.length - 1)
    if (Number.isFinite(end) && end > 0) return end
  }
  return 0
}

/** How far the media has buffered past `time`, as a 0..1 fraction of duration. */
export function bufferedFraction(
  video: HTMLVideoElement,
  duration: number
): number {
  if (duration <= 0 || video.buffered.length === 0) return 0
  const time = video.currentTime
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= time && time <= video.buffered.end(i)) {
      return Math.min(1, video.buffered.end(i) / duration)
    }
  }
  return Math.min(1, video.buffered.end(video.buffered.length - 1) / duration)
}

export function describeMediaError(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was aborted."
    case MediaError.MEDIA_ERR_NETWORK:
      return "Could not read the video file."
    case MediaError.MEDIA_ERR_DECODE:
      return "The video file is corrupt or uses an unsupported codec."
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This video format can't be played."
    default:
      return "Something went wrong playing this video."
  }
}

/** True when the event target is somewhere the user is typing. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.getAttribute("role") === "textbox") return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}
