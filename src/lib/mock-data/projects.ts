// ── Project Helpers ──────────────────────────────────────────────────────────
//
// Date formatting and grouping utilities for projects.
// Works with StoredProject (ISO 8601 string dates from the store).

import type { StoredProject } from "../../../electron/store/types"

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

/**
 * Format an ISO date string into a compact relative time string.
 * Examples: "2m", "3h", "4d", "2w", "1mo", "1y"
 */
export function formatRelativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then

  const seconds = Math.floor(diffMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const weeks = Math.floor(days / 7)
  const months = Math.floor(days / 30)
  const years = Math.floor(days / 365)

  if (years > 0) return `${years}y`
  if (months > 0) return `${months}mo`
  if (weeks > 0) return `${weeks}w`
  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return "now"
}

export function groupProjects(
  projects: StoredProject[]
): { label: string; items: StoredProject[] }[] {
  const now = new Date()
  const groups: { label: string; items: StoredProject[] }[] = []
  const thirtyDaysAgo = new Date(now)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const startOfYear = new Date(now.getFullYear(), 0, 1)

  const recent: StoredProject[] = []
  const thisYear: StoredProject[] = []
  const older: StoredProject[] = []

  for (const p of projects) {
    const d = new Date(p.createdAt)
    if (d >= thirtyDaysAgo) recent.push(p)
    else if (d >= startOfYear) thisYear.push(p)
    else older.push(p)
  }

  if (recent.length) groups.push({ label: "Last 30 days", items: recent })
  if (thisYear.length) groups.push({ label: "This year", items: thisYear })
  if (older.length) groups.push({ label: "Older", items: older })

  return groups
}
