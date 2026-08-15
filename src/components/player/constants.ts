/** Trailing window after `seeked` before scrub mode ends. A drag fires
 *  seeking/seeked dozens of times a second; without this the player thrashes. */
export const SCRUB_END_DEBOUNCE_MS = 150

/** How often playback time is pushed into React. The scrubber itself is
 *  driven imperatively at 60fps — this only paces the text readout. */
export const UI_TIME_INTERVAL_MS = 250

/** How long playback may sit stalled before it is treated as an error. */
export const STALL_TIMEOUT_MS = 10_000

/** Bail-out for the Infinity-duration probe (MediaRecorder WebM). */
export const DURATION_RESOLVE_TIMEOUT_MS = 1500

export const SEEK_STEP_S = 5
export const SEEK_STEP_LARGE_S = 10
export const VOLUME_STEP = 0.05

/** Keeps the final frame addressable without tripping `ended`. */
export const DURATION_EPSILON_S = 0.05

export const VOLUME_KEY = "player.volume"
export const MUTED_KEY = "player.muted"
