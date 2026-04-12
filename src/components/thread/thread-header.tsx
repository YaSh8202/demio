import { useNavigate } from "react-router-dom"
import {
  ArrowLeft,
  ArrowRight,
  SquarePen,
  MoreHorizontal,
  Globe,
  Video,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
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

export type RightPanelTab = "browser" | "video" | null

const isMac = appInfo?.platform === "darwin"

interface ThreadHeaderProps {
  threadTitle: string
  projectName: string
  rightPanelTab: RightPanelTab
  onRightPanelTabChange: (tab: RightPanelTab) => void
  onNewThread: () => void
  onRenameThread?: () => void
  onDeleteThread?: () => void
}

export function ThreadHeader({
  threadTitle,
  projectName,
  rightPanelTab,
  onRightPanelTabChange,
  onNewThread,
  onRenameThread,
  onDeleteThread,
}: ThreadHeaderProps) {
  const navigate = useNavigate()
  const { open: sidebarOpen } = useSidebar()

  function toggleTab(tab: "browser" | "video") {
    onRightPanelTabChange(rightPanelTab === tab ? null : tab)
  }

  return (
    <header
      className={cn(
        "drag-region flex h-12 shrink-0 items-center gap-1 border-b border-sidebar-border px-2",
        !sidebarOpen && isMac && "pl-[78px]"
      )}
    >
      {/* Left cluster — only visible when sidebar is collapsed */}
      {!sidebarOpen && (
        <div className="no-drag flex items-center gap-0.5">
          <SidebarTrigger />

          <Separator orientation="vertical" className="mx-1 h-4" />

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

          <Separator orientation="vertical" className="mx-1 h-4" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onNewThread}>
                <SquarePen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New thread</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Center cluster — thread title + project badge + more menu */}
      <div className="no-drag flex min-w-0 flex-1 items-center justify-center gap-2">
        <h1 className="truncate text-sm font-semibold">{threadTitle}</h1>
        {projectName && (
          <Badge variant="secondary" className="shrink-0 text-xs font-normal">
            {projectName}
          </Badge>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="shrink-0">
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
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

      {/* Right cluster — panel toggle icons */}
      <div className="no-drag flex items-center gap-0.5">
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
      </div>
    </header>
  )
}
