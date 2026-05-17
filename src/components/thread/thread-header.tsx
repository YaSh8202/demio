import { useNavigate } from "react-router-dom"
import {
  ArrowLeft,
  ArrowRight,
  SquarePen,
  MoreHorizontal,
  Globe,
  Video,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { appInfo } from "@/types/electron-api"

export type RightPanelTab = "browser" | "video" | "script" | null

const isMac = appInfo?.platform === "darwin"

// Width reserved for the floating ThreadActions cluster on the left edge.
// Matches the sidebar width so the inline header's title appears at the same
// x-position regardless of sidebar state (no horizontal shift on toggle).
const ACTIONS_RESERVE_PX = 256

// ── Floating action cluster ──────────────────────────────────────────────────
// Fixed at top-left of the window with a z-index above the sidebar. When the
// sidebar is open these icons visually sit *inside* the sidebar's painted top
// strip; when closed they sit over the main content. They never move x.

interface ThreadActionsProps {
  onNewThread: () => void
}

export function ThreadActions({ onNewThread }: ThreadActionsProps) {
  const navigate = useNavigate()
  const { open: sidebarOpen } = useSidebar()

  return (
    <div
      className={cn(
        "drag-region fixed top-0 left-0 z-30 flex h-12 items-center px-2",
        isMac && "pl-[78px]"
      )}
    >
      <div className="no-drag flex items-center gap-0.5">
        <SidebarTrigger />

        <Separator orientation="vertical" className="mx-1 h-4" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => navigate(1)}>
              <ArrowRight className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Forward</TooltipContent>
        </Tooltip>

        {/* New-thread icon only shown when sidebar is closed — when open,
            the sidebar renders its own "New thread" button below the list. */}
        {!sidebarOpen && (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={onNewThread}>
                  <SquarePen className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New thread</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}

// ── Inline main header ───────────────────────────────────────────────────────
// Lives inside SidebarInset. Contains title + project badge + more menu on the
// left, and the panel-toggle cluster on the right. When the sidebar is closed
// we pad the left so the title clears the floating ThreadActions overlay.

interface ThreadHeaderProps {
  threadTitle: string
  rightPanelTab: RightPanelTab
  onRightPanelTabChange: (tab: RightPanelTab) => void
  onRenameThread?: () => void
  onDeleteThread?: () => void
}

export function ThreadHeader({
  threadTitle,
  rightPanelTab,
  onRightPanelTabChange,
  onRenameThread,
  onDeleteThread,
}: ThreadHeaderProps) {
  const { open: sidebarOpen } = useSidebar()

  function toggleTab(tab: "browser" | "video" | "script") {
    onRightPanelTabChange(rightPanelTab === tab ? null : tab)
  }

  return (
    <header
      className="flex h-12 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-3"
      style={!sidebarOpen ? { paddingLeft: ACTIONS_RESERVE_PX } : undefined}
    >
      {/* Left: title + project badge + more menu.
          drag-region is on this inner cluster (not on the <header> outer) so
          it never overlaps with ThreadActions's bbox — Electron's drag-region
          calc isn't z-index aware and would otherwise leak drag onto the
          floating actions and eat their clicks. */}
      <div className="drag-region flex min-w-0 flex-1 items-center gap-2.5">
        <h1 className="truncate text-[12.5px] font-semibold">{threadTitle}</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="no-drag shrink-0"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={onRenameThread}>
              Rename thread
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDeleteThread}
              className="text-destructive focus:text-destructive"
            >
              Delete thread
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Right cluster — panel toggle icons (no drag-region needed since
          outer <header> isn't drag-region) */}
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => toggleTab("browser")}
              className={cn(rightPanelTab === "browser" && "bg-muted")}
            >
              <Globe className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Browser preview</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => toggleTab("video")}
              className={cn(rightPanelTab === "video" && "bg-muted")}
            >
              <Video className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Video</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => toggleTab("script")}
              className={cn(rightPanelTab === "script" && "bg-muted")}
            >
              <Sparkles className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Script</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
