import { useCallback, useEffect, useRef, useState } from "react"
import { sharedStorage } from "@/types/electron-api"
import {
  DURATION_EPSILON_S,
  DURATION_RESOLVE_TIMEOUT_MS,
  MUTED_KEY,
  SCRUB_END_DEBOUNCE_MS,
  STALL_TIMEOUT_MS,
  UI_TIME_INTERVAL_MS,
  VOLUME_KEY,
} from "./constants"
import {
  bufferedFraction,
  describeMediaError,
  resolveDuration,
} from "./player-utils"

export type PlayerStatus = "loading" | "ready" | "stalled" | "error"

export interface VideoPlayerApi {
  videoRef: React.RefObject<HTMLVideoElement | null>
  scrubberRef: React.RefObject<HTMLInputElement | null>
  bufferedFillRef: React.RefObject<HTMLDivElement | null>

  playing: boolean
  ended: boolean
  duration: number
  /** Throttled — for text readouts only, never for the scrubber position. */
  uiTime: number
  seekable: boolean
  status: PlayerStatus
  errorText: string | null
  volume: number
  muted: boolean

  play: () => void
  pause: () => void
  togglePlay: () => void
  seekTo: (time: number) => void
  seekBy: (delta: number) => void
  setVolume: (value: number) => void
  toggleMute: () => void
  onScrubStart: () => void
  onScrubInput: (time: number) => void
}

function readStoredNumber(key: string, fallback: number): number {
  const stored = sharedStorage?.get(key)
  return typeof stored === "number" && Number.isFinite(stored)
    ? stored
    : fallback
}

/**
 * Drives a single <video> element.
 *
 * The design rule: anything that changes at frame rate lives in a ref and is
 * written straight to the DOM. React state is reserved for things that change
 * a few times a second at most, so playback never re-renders the tree at
 * 60fps.
 */
export function useVideoPlayer(src: string | null): VideoPlayerApi {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scrubberRef = useRef<HTMLInputElement | null>(null)
  const bufferedFillRef = useRef<HTMLDivElement | null>(null)

  // Hot path — never triggers a render.
  const allowPlaybackRef = useRef(false)
  const isSeekingRef = useRef(false)
  const isScrubbingRef = useRef(false)
  const scrubEndTimerRef = useRef<number | null>(null)
  const wasPlayingBeforeScrubRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const durationRef = useRef(0)
  const lastUiPushRef = useRef(0)
  const isResolvingDurationRef = useRef(false)
  const stallTimerRef = useRef<number | null>(null)
  const stallTimeRef = useRef(0)
  const pendingSeekRef = useRef<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [ended, setEnded] = useState(false)
  const [duration, setDuration] = useState(0)
  const [uiTime, setUiTime] = useState(0)
  const [status, setStatus] = useState<PlayerStatus>("loading")
  const [errorText, setErrorText] = useState<string | null>(null)
  const [volume, setVolumeState] = useState(() =>
    Math.min(1, Math.max(0, readStoredNumber(VOLUME_KEY, 1)))
  )
  const [muted, setMutedState] = useState(
    () => sharedStorage?.get(MUTED_KEY) === true
  )

  const seekable = duration > 0

  // ── time plumbing ────────────────────────────────────────────────────────

  /** Write the scrubber + buffered bar directly; only pace the React text. */
  const paintTime = useCallback((time: number, force: boolean) => {
    const video = videoRef.current
    const total = durationRef.current

    if (scrubberRef.current && !isScrubbingRef.current && total > 0) {
      scrubberRef.current.value = String(time)
    }
    if (bufferedFillRef.current && video) {
      const fraction = bufferedFraction(video, total)
      bufferedFillRef.current.style.transform = `scaleX(${fraction})`
    }

    const now = performance.now()
    if (force || now - lastUiPushRef.current >= UI_TIME_INTERVAL_MS) {
      lastUiPushRef.current = now
      setUiTime(time)
    }
  }, [])

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startRaf = useCallback(() => {
    stopRaf()
    const tick = () => {
      const video = videoRef.current
      if (!video || video.paused || video.ended) {
        rafRef.current = null
        return
      }
      paintTime(video.currentTime, false)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [paintTime, stopRaf])

  // ── stall watchdog ───────────────────────────────────────────────────────

  const clearStallTimer = useCallback(() => {
    if (stallTimerRef.current !== null) {
      window.clearTimeout(stallTimerRef.current)
      stallTimerRef.current = null
    }
  }, [])

  const armStallTimer = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    clearStallTimer()
    stallTimeRef.current = video.currentTime
    stallTimerRef.current = window.setTimeout(() => {
      const current = videoRef.current
      if (!current) return
      // Only a real error if time genuinely never moved.
      if (current.currentTime === stallTimeRef.current && !current.paused) {
        console.error("[player] stalled", {
          currentTime: current.currentTime,
          readyState: current.readyState,
          networkState: current.networkState,
        })
        setStatus("error")
        setErrorText("Playback stalled — the video file may be unreadable.")
      }
    }, STALL_TIMEOUT_MS)
  }, [clearStallTimer])

  // ── controls ─────────────────────────────────────────────────────────────

  const play = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    allowPlaybackRef.current = true
    const attempt = video.play()
    if (!attempt) return
    attempt.catch((error: DOMException) => {
      // A pause or seek raced the play promise — expected, not a failure.
      if (error.name === "AbortError") return
      if (error.name === "NotAllowedError" && !video.muted) {
        video.muted = true
        setMutedState(true)
        video.play().catch(() => {})
        return
      }
      allowPlaybackRef.current = false
      console.error("[player] play failed", error)
      setStatus("error")
      setErrorText("Playback could not start.")
    })
  }, [])

  const pause = useCallback(() => {
    allowPlaybackRef.current = false
    videoRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) play()
    else pause()
  }, [play, pause])

  const seekTo = useCallback(
    (time: number) => {
      const video = videoRef.current
      if (!video) return

      // Before metadata the element silently ignores currentTime writes.
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        pendingSeekRef.current = time
        return
      }

      const total = durationRef.current
      const max = total > 0 ? total - DURATION_EPSILON_S : time
      const clamped = Math.min(Math.max(0, time), Math.max(0, max))
      isSeekingRef.current = true
      setEnded(false)
      video.currentTime = clamped
      paintTime(clamped, true)
    },
    [paintTime]
  )

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current
      if (!video) return
      seekTo(video.currentTime + delta)
    },
    [seekTo]
  )

  const onScrubStart = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    isScrubbingRef.current = true
    wasPlayingBeforeScrubRef.current = !video.paused
    // Deliberately not clearing allowPlaybackRef: the resume after the drag
    // must not be vetoed by the play gate.
    if (!video.paused) video.pause()
  }, [])

  const onScrubInput = useCallback(
    (time: number) => {
      isScrubbingRef.current = true
      seekTo(time)
    },
    [seekTo]
  )

  const setVolume = useCallback((value: number) => {
    const clamped = Math.min(1, Math.max(0, value))
    setVolumeState(clamped)
    if (clamped > 0) setMutedState(false)
  }, [])

  const toggleMute = useCallback(() => setMutedState((m) => !m), [])

  // ── persistence ──────────────────────────────────────────────────────────

  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.volume = volume
      video.muted = muted
    }
    sharedStorage?.set(VOLUME_KEY, volume)
    sharedStorage?.set(MUTED_KEY, muted)
  }, [volume, muted, src])

  // ── element wiring ───────────────────────────────────────────────────────

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    // A new src means a new element; reset everything derived from the old one.
    durationRef.current = 0
    allowPlaybackRef.current = false
    isSeekingRef.current = false
    isScrubbingRef.current = false
    pendingSeekRef.current = null
    lastUiPushRef.current = 0
    setPlaying(false)
    setEnded(false)
    setDuration(0)
    setUiTime(0)
    setStatus("loading")
    setErrorText(null)

    video.volume = volume
    video.muted = muted

    const applyDuration = () => {
      const resolved = resolveDuration(video)
      if (resolved > 0 && resolved !== durationRef.current) {
        durationRef.current = resolved
        setDuration(resolved)
      }
      return resolved
    }

    /**
     * MediaRecorder WebM reports `duration === Infinity` until played
     * through. Nudge it with a muted play + a far-future seek and watch for
     * the metadata to settle; bail out so a stubborn file can't hang the UI.
     */
    let durationProbeTimer: number | null = null
    const endProbe = (previousMuted: boolean) => {
      if (!isResolvingDurationRef.current) return
      video.removeEventListener("durationchange", onProbeProgress)
      video.removeEventListener("timeupdate", onProbeProgress)
      if (durationProbeTimer !== null) window.clearTimeout(durationProbeTimer)
      durationProbeTimer = null
      video.pause()
      try {
        video.currentTime = 0
      } catch {
        /* element may not be seekable yet */
      }
      video.muted = previousMuted
      isResolvingDurationRef.current = false
    }
    function onProbeProgress() {
      if (applyDuration() > 0) endProbe(muted)
    }
    const startDurationProbe = () => {
      if (isResolvingDurationRef.current) return
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) return
      isResolvingDurationRef.current = true
      const previousMuted = video.muted
      video.addEventListener("durationchange", onProbeProgress)
      video.addEventListener("timeupdate", onProbeProgress)
      durationProbeTimer = window.setTimeout(() => {
        applyDuration()
        endProbe(previousMuted)
      }, DURATION_RESOLVE_TIMEOUT_MS)
      video.muted = true
      video.play().catch(() => {})
      try {
        video.currentTime = 24 * 60 * 60
      } catch {
        endProbe(previousMuted)
      }
    }

    const onLoadedMetadata = () => {
      console.debug("[player] loadedmetadata", {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        seekable: video.seekable.length,
      })
      if (applyDuration() === 0) startDurationProbe()
      if (pendingSeekRef.current !== null) {
        const pending = pendingSeekRef.current
        pendingSeekRef.current = null
        seekTo(pending)
      }
    }

    const onDurationChange = () => applyDuration()

    const onCanPlay = () => {
      clearStallTimer()
      setStatus((prev) => (prev === "error" ? prev : "ready"))
    }

    const onPlay = () => {
      // The duration probe drives the element itself; let it through.
      if (isResolvingDurationRef.current) return
      if (isSeekingRef.current) {
        video.pause()
        return
      }
      if (!allowPlaybackRef.current) {
        video.pause()
        return
      }
      setPlaying(true)
      setEnded(false)
      setStatus((prev) => (prev === "error" ? prev : "ready"))
      startRaf()
    }

    const onPlaying = () => {
      clearStallTimer()
      setStatus((prev) => (prev === "error" ? prev : "ready"))
    }

    const onPause = () => {
      if (isResolvingDurationRef.current) return
      setPlaying(false)
      stopRaf()
      clearStallTimer()
      paintTime(video.currentTime, true)
    }

    const onSeeking = () => {
      isSeekingRef.current = true
      if (scrubEndTimerRef.current !== null) {
        window.clearTimeout(scrubEndTimerRef.current)
        scrubEndTimerRef.current = null
      }
    }

    const onSeeked = () => {
      isSeekingRef.current = false
      paintTime(video.currentTime, true)

      if (!isScrubbingRef.current) return
      // Rapid drags fire seeked continuously; only settle once it goes quiet.
      if (scrubEndTimerRef.current !== null) {
        window.clearTimeout(scrubEndTimerRef.current)
      }
      scrubEndTimerRef.current = window.setTimeout(() => {
        isScrubbingRef.current = false
        scrubEndTimerRef.current = null
        if (wasPlayingBeforeScrubRef.current) {
          wasPlayingBeforeScrubRef.current = false
          play()
        }
      }, SCRUB_END_DEBOUNCE_MS)
    }

    const onWaiting = () => {
      setStatus((prev) => (prev === "error" ? prev : "stalled"))
      armStallTimer()
    }

    const onProgress = () => {
      if (bufferedFillRef.current) {
        const fraction = bufferedFraction(video, durationRef.current)
        bufferedFillRef.current.style.transform = `scaleX(${fraction})`
      }
    }

    const onEnded = () => {
      allowPlaybackRef.current = false
      setPlaying(false)
      setEnded(true)
      stopRaf()
      clearStallTimer()
      // A file whose duration never resolved has now revealed it.
      if (durationRef.current === 0 && video.currentTime > 0) {
        durationRef.current = video.currentTime
        setDuration(video.currentTime)
      }
      paintTime(video.currentTime, true)
    }

    const onError = () => {
      stopRaf()
      clearStallTimer()
      console.error("[player] error", {
        code: video.error?.code,
        message: video.error?.message,
        readyState: video.readyState,
        networkState: video.networkState,
        src,
      })
      setPlaying(false)
      setStatus("error")
      setErrorText(describeMediaError(video.error))
    }

    // Chromium aborts constantly by design — log only, never surface.
    const onAbort = () => console.debug("[player] abort")

    video.addEventListener("loadedmetadata", onLoadedMetadata)
    video.addEventListener("durationchange", onDurationChange)
    video.addEventListener("canplay", onCanPlay)
    video.addEventListener("play", onPlay)
    video.addEventListener("playing", onPlaying)
    video.addEventListener("pause", onPause)
    video.addEventListener("seeking", onSeeking)
    video.addEventListener("seeked", onSeeked)
    video.addEventListener("waiting", onWaiting)
    video.addEventListener("stalled", onWaiting)
    video.addEventListener("progress", onProgress)
    video.addEventListener("ended", onEnded)
    video.addEventListener("error", onError)
    video.addEventListener("abort", onAbort)

    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata)
      video.removeEventListener("durationchange", onDurationChange)
      video.removeEventListener("canplay", onCanPlay)
      video.removeEventListener("play", onPlay)
      video.removeEventListener("playing", onPlaying)
      video.removeEventListener("pause", onPause)
      video.removeEventListener("seeking", onSeeking)
      video.removeEventListener("seeked", onSeeked)
      video.removeEventListener("waiting", onWaiting)
      video.removeEventListener("stalled", onWaiting)
      video.removeEventListener("progress", onProgress)
      video.removeEventListener("ended", onEnded)
      video.removeEventListener("error", onError)
      video.removeEventListener("abort", onAbort)
      video.removeEventListener("durationchange", onProbeProgress)
      video.removeEventListener("timeupdate", onProbeProgress)
      if (durationProbeTimer !== null) window.clearTimeout(durationProbeTimer)
      if (scrubEndTimerRef.current !== null) {
        window.clearTimeout(scrubEndTimerRef.current)
        scrubEndTimerRef.current = null
      }
      isResolvingDurationRef.current = false
      stopRaf()
      clearStallTimer()
    }
    // `volume`/`muted` are applied by their own effect; re-running this on a
    // volume change would tear down every listener mid-playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  return {
    videoRef,
    scrubberRef,
    bufferedFillRef,
    playing,
    ended,
    duration,
    uiTime,
    seekable,
    status,
    errorText,
    volume,
    muted,
    play,
    pause,
    togglePlay,
    seekTo,
    seekBy,
    setVolume,
    toggleMute,
    onScrubStart,
    onScrubInput,
  }
}
