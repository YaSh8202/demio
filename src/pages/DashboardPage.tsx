import { useState, useMemo } from "react"
import { Search, Plus, ArrowUp, FileText } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// ── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string
  name: string
  createdAt: Date
}

const now = new Date()
function daysAgo(n: number) {
  const d = new Date(now)
  d.setDate(d.getDate() - n)
  return d
}

const INITIAL_PROJECTS: Project[] = [
  {
    id: "1",
    name: "Marketing Site Redesign",
    createdAt: daysAgo(2),
  },
  {
    id: "2",
    name: "Mobile App Prototype",
    createdAt: daysAgo(5),
  },
  {
    id: "3",
    name: "Dashboard Analytics",
    createdAt: daysAgo(12),
  },
  {
    id: "4",
    name: "E-commerce Store",
    createdAt: daysAgo(45),
  },
  {
    id: "5",
    name: "Portfolio Website",
    createdAt: daysAgo(60),
  },
  {
    id: "6",
    name: "Social Media App",
    createdAt: daysAgo(90),
  },
  {
    id: "7",
    name: "Recipe Finder",
    createdAt: daysAgo(120),
  },
  {
    id: "8",
    name: "Fitness Tracker",
    createdAt: daysAgo(150),
  },
]

const SUGGESTIONS = [
  "A task management app with kan...",
  "Build a landing page for a SaaS...",
  "Create a real-time chat applica...",
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function groupProjects(projects: Project[]) {
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

// ── Components ───────────────────────────────────────────────────────────────

function ProjectItem({
  project,
  isSelected,
  onClick,
}: {
  project: Project
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
        isSelected ? "bg-white/10" : "hover:bg-white/5"
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          {project.name}
        </p>
        <div className="flex items-center gap-1 text-xs text-white/50">
          <FileText className="size-3" />
          <span>{formatDate(project.createdAt)}</span>
        </div>
      </div>
    </button>
  )
}

function ProjectSidebar({
  projects,
  search,
  onSearchChange,
  selectedId,
  onSelect,
}: {
  projects: Project[]
  search: string
  onSearchChange: (value: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const filtered = useMemo(() => {
    if (!search.trim()) return projects
    const q = search.toLowerCase()
    return projects.filter((p) => p.name.toLowerCase().includes(q))
  }, [projects, search])

  const groups = useMemo(() => groupProjects(filtered), [filtered])

  return (
    <div className="flex w-80 shrink-0 flex-col rounded-2xl bg-white/[0.06] backdrop-blur-sm">
      {/* Search */}
      <div className="px-3 pt-3 pb-1">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-white/40" />
          <Input
            placeholder="Search projects"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-9 border-none bg-white/[0.06] pl-9 text-white shadow-none placeholder:text-white/40 focus-visible:ring-0"
          />
        </div>
      </div>

      {/* Project list */}
      <ScrollArea className="flex-1">
        <div className="px-2 pb-3">
          {groups.length === 0 && (
            <p className="py-8 text-center text-sm text-white/40">
              No projects found
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label} className="mt-4 first:mt-2">
              <h3 className="mb-1.5 px-2 text-xs font-semibold text-white/60">
                {group.label}
              </h3>
              <div className="flex flex-col gap-0.5">
                {group.items.map((project) => (
                  <ProjectItem
                    key={project.id}
                    project={project}
                    isSelected={selectedId === project.id}
                    onClick={() => onSelect(project.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function SuggestionChip({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
    >
      {label}
    </button>
  )
}

function CreateProjectInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
}) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (value.trim()) onSubmit()
    }
  }

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-white/[0.06]">
      <Textarea
        placeholder="What shall we build?"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        className="min-h-24 resize-none border-none bg-transparent px-5 pt-5 text-base text-white shadow-none placeholder:text-white/40 focus-visible:ring-0"
      />
      <div className="flex items-center justify-between px-4 pb-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0 text-white/40 hover:bg-white/10 hover:text-white/60"
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <Button
          size="sm"
          className="size-8 rounded-full bg-white/20 p-0 text-white hover:bg-white/30"
          disabled={!value.trim()}
          onClick={onSubmit}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>(INITIAL_PROJECTS)
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newProjectName, setNewProjectName] = useState("")

  const handleCreateProject = () => {
    const name = newProjectName.trim()
    if (!name) return

    const project: Project = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date(),
    }

    setProjects((prev) => [project, ...prev])
    setSelectedId(project.id)
    setNewProjectName("")
  }

  const handleSuggestionClick = (suggestion: string) => {
    setNewProjectName(suggestion)
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-neutral-950">
      {/* App header */}
      <header className="flex shrink-0 items-center px-5 pt-4 pb-3">
        <h2 className="text-lg font-bold tracking-tight text-white">Demio</h2>
      </header>

      {/* Content area */}
      <div className="flex min-h-0 flex-1 gap-0 px-4 pb-4">
        {/* Left sidebar card */}
        <ProjectSidebar
          projects={projects}
          search={search}
          onSearchChange={setSearch}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {/* Right main area */}
        <main className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6">
          {/* Welcome heading */}
          <h1 className="text-center text-6xl font-bold tracking-tight text-white">
            Welcome to Demio.
          </h1>

          {/* Suggestion chips */}
          <div className="flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <SuggestionChip
                key={s}
                label={s}
                onClick={() => handleSuggestionClick(s)}
              />
            ))}
          </div>

          {/* Create project input */}
          <CreateProjectInput
            value={newProjectName}
            onChange={setNewProjectName}
            onSubmit={handleCreateProject}
          />
        </main>
      </div>
    </div>
  )
}

export default DashboardPage
