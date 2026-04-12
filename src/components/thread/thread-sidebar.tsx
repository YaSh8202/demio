import { useNavigate, Link } from "react-router-dom"
import {
  Search,
  Pin,
  ListFilter,
  ArrowUpDown,
  ArrowLeft,
  ArrowRight,
  SquarePen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatRelativeTime } from "@/lib/mock-data/projects"
import { cn } from "@/lib/utils"
import { appInfo } from "@/types/electron-api"
import type { StoredThread } from "../../../../electron/store/types"
import { useMemo, useState } from "react"

const isMac = appInfo?.platform === "darwin"

interface ThreadSidebarProps {
  threads: StoredThread[]
  activeThreadId: string
  projectId: string
  onNewThread: () => void
}

export function ThreadSidebar({
  threads,
  activeThreadId,
  projectId,
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
      {/* Navigation bar — toggle, back/forward, new thread */}
      <SidebarHeader
        className={cn(
          "drag-region flex-row items-center gap-0.5",
          isMac && "traffic-light-pad"
        )}
      >
        <div className="no-drag flex items-center gap-0.5">
          <SidebarTrigger />

          <Separator orientation="vertical" className="mx-0.5 h-4" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => navigate(-1)}
              >
                <ArrowLeft className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => navigate(1)}
              >
                <ArrowRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Forward</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="mx-0.5 h-4" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onNewThread}>
                <SquarePen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New thread</TooltipContent>
          </Tooltip>
        </div>
      </SidebarHeader>

      {/* Search */}
      <div className="px-2 pb-1">
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

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>
            Threads
            <span className="ml-1 text-sidebar-foreground/40">
              {threads.length}
            </span>
          </SidebarGroupLabel>
          <SidebarGroupAction title="Pin">
            <Pin className="size-3.5" />
          </SidebarGroupAction>

          <div className="flex items-center gap-0.5 px-2 pb-1">
            <button
              type="button"
              className="rounded p-1 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              title="Filter"
            >
              <ListFilter className="size-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-1 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              title="Sort"
            >
              <ArrowUpDown className="size-3.5" />
            </button>
          </div>

          <SidebarGroupContent>
            <SidebarMenu>
              {filtered.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-sidebar-foreground/40">
                  No threads found
                </p>
              )}
              {filtered.map((thread) => (
                <SidebarMenuItem key={thread.id}>
                  <SidebarMenuButton
                    asChild
                    isActive={thread.id === activeThreadId}
                    tooltip={thread.title}
                  >
                    <Link to={`/projects/${projectId}/threads/${thread.id}`}>
                      <span className="truncate">{thread.title}</span>
                    </Link>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>
                    {formatRelativeTime(thread.updatedAt)}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  )
}
