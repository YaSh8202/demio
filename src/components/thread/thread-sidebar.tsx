import { Link, useNavigate } from "react-router-dom"
import { Home, Search, FileText, SquarePen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarContent, SidebarInput } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatRelativeTime } from "@/lib/mock-data/projects"
import { cn } from "@/lib/utils"
import type { StoredProject, StoredThread } from "@electron/store/types"
import { useMemo, useState } from "react"

interface ThreadSidebarProps {
  threads: StoredThread[]
  activeThreadId: string
  projectId: string
  project: StoredProject | null
  isStreaming: boolean
  onNewThread: () => void
}

// ── Favicon tile ─────────────────────────────────────────────────────────────

function FaviconTile({
  domain,
  size = 20,
}: {
  domain: string | null | undefined
  size?: number
}) {
  if (!domain) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-sm border border-white/[0.06] bg-white/[0.06]"
        style={{ width: size, height: size }}
      >
        <FileText className="size-3 text-white/40" />
      </span>
    )
  }
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-sm border border-white/[0.06] bg-white/[0.06]"
      style={{ width: size, height: size }}
    >
      <img
        src={`https://www.google.com/s2/favicons?sz=64&domain=${domain}`}
        alt=""
        width={Math.round(size * 0.7)}
        height={Math.round(size * 0.7)}
        onError={(e) => {
          e.currentTarget.style.display = "none"
        }}
      />
    </span>
  )
}

export function ThreadSidebar({
  threads,
  activeThreadId,
  projectId,
  project,
  isStreaming,
  onNewThread,
}: ThreadSidebarProps) {
  const navigate = useNavigate()
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    if (!search.trim()) return threads
    const q = search.toLowerCase()
    return threads.filter((t) => t.title.toLowerCase().includes(q))
  }, [threads, search])

  return (
    <>
      {/* Project banner — top padding clears the floating header (h-12) */}
      <div className="px-3 pt-15">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">
            Project
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="-mr-1 size-5 text-white/50 hover:text-white"
                onClick={() => navigate("/")}
              >
                <Home className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Home</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2.5 rounded-md border border-white/[0.05] bg-white/[0.04] px-2.5 py-2">
          <FaviconTile domain={project?.domain} size={20} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-semibold text-white">
              {project?.name ?? "—"}
            </p>
            {project?.domain && (
              <p className="mt-0.5 truncate font-mono text-[10px] text-white/45">
                {project.domain}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pt-3 pb-1">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-sidebar-foreground/50" />
          <SidebarInput
            placeholder="Search threads"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <SidebarContent className="px-0">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">
            Threads
          </span>
          <span className="font-mono text-[9.5px] text-white/30">
            {threads.length}
          </span>
        </div>

        {filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-sidebar-foreground/40">
            No threads found
          </p>
        )}

        <div className="flex flex-col">
          {filtered.map((thread) => {
            const isActive = thread.id === activeThreadId
            const isRendering = isActive && isStreaming
            const dotColor = isRendering ? "bg-amber-400" : "bg-emerald-400/80"
            return (
              <Link
                key={thread.id}
                to={`/projects/${projectId}/threads/${thread.id}`}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2.5 border-l-2 px-3 py-2 transition-colors",
                  isActive
                    ? "border-l-[var(--accent-brand)] bg-white/[0.04]"
                    : "border-l-transparent hover:border-l-[var(--accent-brand)] hover:bg-white/[0.03]"
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    dotColor,
                    isRendering && "pulse-dot"
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12.5px]",
                    isActive
                      ? "font-semibold text-white"
                      : "font-medium text-white/90"
                  )}
                >
                  {thread.title}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-white/40">
                  {formatRelativeTime(thread.updatedAt)}
                </span>
              </Link>
            )
          })}
        </div>

        {/* New thread button — appears after the threads list when the sidebar
            is open; when closed, the same action lives in ThreadActions. */}
        <button
          onClick={onNewThread}
          className="flex w-full items-center gap-2.5 border-l-2 border-l-transparent px-3 py-2.5 text-[12.5px] font-medium text-white/85 transition-colors hover:border-l-[var(--accent-brand)] hover:bg-white/[0.03] hover:text-white"
        >
          <SquarePen className="size-3.5" />
          New thread
        </button>
      </SidebarContent>
    </>
  )
}
