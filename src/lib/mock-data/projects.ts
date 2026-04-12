// ── Types ────────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  createdAt: Date
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const now = new Date()

export function daysAgo(n: number): Date {
  const d = new Date(now)
  d.setDate(d.getDate() - n)
  return d
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function groupProjects(
  projects: Project[]
): { label: string; items: Project[] }[] {
  const groups: { label: string; items: Project[] }[] = []
  const thirtyDaysAgo = daysAgo(30)
  const startOfYear = new Date(now.getFullYear(), 0, 1)

  const recent: Project[] = []
  const thisYear: Project[] = []
  const older: Project[] = []

  for (const p of projects) {
    if (p.createdAt >= thirtyDaysAgo) recent.push(p)
    else if (p.createdAt >= startOfYear) thisYear.push(p)
    else older.push(p)
  }

  if (recent.length) groups.push({ label: "Last 30 days", items: recent })
  if (thisYear.length) groups.push({ label: "This year", items: thisYear })
  if (older.length) groups.push({ label: "Older", items: older })

  return groups
}

// ── Mock Data ────────────────────────────────────────────────────────────────

export const INITIAL_PROJECTS: Project[] = [
  { id: "1", name: "Marketing Site Redesign", createdAt: daysAgo(2) },
  { id: "2", name: "Mobile App Prototype", createdAt: daysAgo(5) },
  { id: "3", name: "Dashboard Analytics", createdAt: daysAgo(12) },
  { id: "4", name: "E-commerce Store", createdAt: daysAgo(45) },
  { id: "5", name: "Portfolio Website", createdAt: daysAgo(60) },
  { id: "6", name: "Social Media App", createdAt: daysAgo(90) },
  { id: "7", name: "Recipe Finder", createdAt: daysAgo(120) },
  { id: "8", name: "Fitness Tracker", createdAt: daysAgo(150) },
]
