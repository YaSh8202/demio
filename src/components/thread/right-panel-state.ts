// ── Right Panel Layout Persistence ───────────────────────────────────────────
//
// One record owns the whole right-panel layout: whether it's open, which tab it
// was on, and how wide it was. This deliberately replaces the library's
// `useDefaultLayout` hook — that stored only sizes, in its own localStorage key,
// while the active tab lived in React state. Two stores for one visual state is
// what let them drift: on reload the restored layout re-opened the panel but the
// tab had reset, so the panel always sprang back on "browser".
//
// `tab` is the last *non-null* tab and is never cleared on close, so dragging a
// collapsed panel back open returns you to where you were rather than guessing.

import type { RightPanelTab } from "./thread-header"

const STORAGE_KEY = "demio:right-panel"

/** Opening width the first time, before the user has dragged anything. */
export const DEFAULT_SIZE_PCT = 70

export type RightPanelState = {
  open: boolean
  tab: NonNullable<RightPanelTab>
  sizePct: number
}

const TABS: NonNullable<RightPanelTab>[] = ["browser", "video", "script"]

const FALLBACK: RightPanelState = {
  open: false,
  tab: "browser",
  sizePct: DEFAULT_SIZE_PCT,
}

export function readRightPanelState(): RightPanelState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return FALLBACK

    const parsed = JSON.parse(raw) as Partial<RightPanelState>
    const tab = TABS.includes(parsed.tab as NonNullable<RightPanelTab>)
      ? (parsed.tab as NonNullable<RightPanelTab>)
      : FALLBACK.tab

    // A stored 0 or 100 would mount the group in a degenerate state that the
    // user can't drag out of, so clamp rather than trust the value.
    const sizePct =
      typeof parsed.sizePct === "number" && Number.isFinite(parsed.sizePct)
        ? Math.min(95, Math.max(5, parsed.sizePct))
        : FALLBACK.sizePct

    return { open: parsed.open === true, tab, sizePct }
  } catch {
    return FALLBACK
  }
}

export function writeRightPanelState(state: RightPanelState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota or a disabled store — layout memory isn't worth throwing over.
  }
}
