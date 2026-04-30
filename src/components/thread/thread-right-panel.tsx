import { useCallback, useEffect, useState } from "react"
import { Globe, Video, X } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { LiveBrowserView } from "@/components/preview/LiveBrowserView"
import { apis } from "@/types/electron-api"
import type { RightPanelTab } from "./thread-header"

interface ThreadRightPanelProps {
  activeTab: RightPanelTab
  onTabChange: (tab: RightPanelTab) => void
  videoPath: string | null
}

export function ThreadRightPanel({
  activeTab,
  onTabChange,
  videoPath,
}: ThreadRightPanelProps) {
  const [wsUrl, setWsUrl] = useState<string | null>(null)

  // Fetch stream URL when browser tab becomes active
  useEffect(() => {
    if (activeTab !== "browser" || !apis) return

    apis.stream.getUrl().then((url) => {
      setWsUrl(url)
      if (!url) {
        apis?.stream.enable().then((info) => {
          if (info) {
            setWsUrl(info.wsUrl)
          }
        })
      }
    })
  }, [activeTab])

  // Re-enable the stream when the renderer's WebSocket gives up reconnecting
  // (daemon was killed by `agent-browser close --all` or crashed).
  const handleStaleUrl = useCallback(() => {
    if (!apis) return
    apis.stream.refresh().then((info) => {
      setWsUrl(info?.wsUrl ?? null)
    })
  }, [])

  return (
    <Tabs
      value={activeTab ?? "browser"}
      onValueChange={(v) => onTabChange(v as "browser" | "video")}
      className="flex h-full flex-col"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-sidebar-border px-2 py-1.5">
        <TabsList variant="line" className="h-7">
          <TabsTrigger value="browser" className="gap-1 text-xs">
            <Globe className="size-3" />
            Browser
          </TabsTrigger>
          <TabsTrigger value="video" className="gap-1 text-xs">
            <Video className="size-3" />
            Video
          </TabsTrigger>
        </TabsList>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onTabChange(null)}
        >
          <X className="size-3" />
        </Button>
      </div>

      <TabsContent value="browser" className="flex-1 overflow-hidden p-2">
        <LiveBrowserView
          wsUrl={wsUrl}
          className="size-full rounded-md"
          onStaleUrl={handleStaleUrl}
        />
      </TabsContent>

      <TabsContent value="video" className="flex-1 overflow-hidden">
        {videoPath ? (
          <div className="flex size-full items-center justify-center bg-black p-2">
            <video
              key={videoPath}
              src={`demio-file://${videoPath}`}
              controls
              autoPlay
              className="max-h-full max-w-full rounded-md"
            />
          </div>
        ) : (
          <div className="flex size-full items-center justify-center">
            <div className="text-center">
              <Video className="mx-auto mb-2 size-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No video to preview
              </p>
            </div>
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}
