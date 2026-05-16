import { useMemo } from "react"
import { Search, FileText } from "lucide-react"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { StoredProject } from "../../../electron/store/types"
import { formatRelativeTime } from "@/lib/mock-data/projects"

// ── Favicon tile ────────────────────────────────────────────────────────────

function FaviconTile({ domain }: { domain: string | null | undefined }) {
  if (!domain) {
    return (
      <span className="grid size-[18px] shrink-0 place-items-center rounded-sm border border-white/5 bg-white/5">
        <FileText className="size-3 text-white/40" />
      </span>
    )
  }
  return (
    <span className="grid size-[18px] shrink-0 place-items-center overflow-hidden rounded-sm border border-white/5 bg-white/5">
      <img
        src={`https://www.google.com/s2/favicons?sz=64&domain=${domain}`}
        alt=""
        width={14}
        height={14}
        className="rounded-[2px]"
        onError={(e) => {
          e.currentTarget.style.display = "none"
        }}
      />
    </span>
  )
}

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
        "flex w-full min-w-0 items-start gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors",
        isSelected
          ? "border-l-[var(--accent-brand)] bg-white/[0.04]"
          : "border-l-transparent hover:border-l-[var(--accent-brand)] hover:bg-white/[0.03]"
      )}
    >
      <FaviconTile domain={project.domain} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-white">
          {project.name}
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-white/40">
          {project.domain ?? "—"} · {formatRelativeTime(project.createdAt)}
        </p>
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

  return (
    <div className="flex w-[248px] shrink-0 flex-col border-r border-white/[0.06] bg-sidebar text-sidebar-foreground">
      {/* Search */}
      <div className="px-4 pt-2 pb-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-white/40" />
          <Input
            placeholder="Search projects"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 border-white/[0.06] bg-white/[0.04] pl-8 font-mono text-[11.5px] text-white shadow-none placeholder:text-white/40 focus-visible:ring-0"
          />
        </div>
      </div>

      {/* Project list */}
      <ScrollArea className="flex-1">
        <div className="flex items-center justify-between px-4 pb-2">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.16em] text-white/40 uppercase">
            Last 30 days
          </span>
          <span className="font-mono text-[9.5px] text-white/30">
            {filtered.length}
          </span>
        </div>

        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-white/40">
            No projects found
          </p>
        )}

        <div className="flex flex-col">
          {filtered.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              isSelected={selectedId === project.id}
              onClick={() => onSelect(project.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
