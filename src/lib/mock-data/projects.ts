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
