import { useMemo } from "react"
import { Search, FileText } from "lucide-react"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { StoredProject } from "../../../electron/store/types"
import { formatDate, groupProjects } from "@/lib/mock-data/projects"

// ── ProjectItem ──────────────────────────────────────────────────────────────

function ProjectItem({
  project,
  isSelected,
  onClick,
}: {
  project: StoredProject
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
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

// ── ProjectSidebar ───────────────────────────────────────────────────────────

export function ProjectSidebar({
  projects,
  search,
  onSearchChange,
  selectedId,
  onSelect,
}: {
  projects: StoredProject[]
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
