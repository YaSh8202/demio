import { useCallback, useEffect, useState } from "react"
import { Globe, Video, X, Sparkles, Download, Loader2 } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { LiveBrowserView } from "@/components/preview/LiveBrowserView"
import { VideoPlayer } from "@/components/player/video-player"
import { cn } from "@/lib/utils"
import { apis } from "@/types/electron-api"
import type { RightPanelTab } from "./thread-header"

interface ThreadRightPanelProps {
  activeTab: RightPanelTab
  onTabChange: (tab: RightPanelTab) => void
  videoPath: string | null
  videoGeneration: string | number
  projectDomain?: string | null
}

// ── Browser view ────────────────────────────────────────────────────────────

function BrowserView({
  wsUrl,
  refreshNonce,
  onStaleUrl,
  domain,
}: {
  wsUrl: string | null
  refreshNonce: number
  onStaleUrl: () => void
  domain: string | null | undefined
}) {
  const url = domain ? `${domain}/...` : "loading..."
  return (
    <div className="flex h-full flex-col gap-2.5 p-4">
      {/* URL bar */}
      <div className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5">
        <span className="flex gap-1">
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
        </span>
        <span className="flex-1 truncate font-mono text-[11px] text-white/70">
          {url}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="pulse-dot size-1.5 rounded-full bg-emerald-400" />
          <span className="font-mono text-[9.5px] text-white/45">
            recording
          </span>
        </span>
      </div>

      {/* Stream */}
      <div className="relative flex-1 overflow-hidden rounded-md border border-white/[0.05]">
        <LiveBrowserView
          wsUrl={wsUrl}
          className="size-full"
          onStaleUrl={onStaleUrl}
          refreshNonce={refreshNonce}
        />
      </div>

      {/* Step trail */}
      {/* <div className="flex items-center gap-2 font-mono text-[10px] text-white/50">
        <span className="text-[var(--accent-brand)]">▸</span>
        <span>login → /app → /app/servers →</span>
        <span className="text-white">/app/servers/new</span>
      </div> */}
    </div>
  )
}

// ── Video view ──────────────────────────────────────────────────────────────

function VideoView({
  videoPath,
  videoGeneration,
}: {
  videoPath: string | null
  videoGeneration: string | number
}) {
  return (
    <div className="size-full bg-black p-2">
      <VideoPlayer filePath={videoPath} generation={videoGeneration} />
    </div>
  )
}

// ── Script view ─────────────────────────────────────────────────────────────

const SCRIPT_LINES = [
  {
    i: 1,
    time: "0:00",
    body: "Meet RemoteMCP — manage MCP servers without the infra headache.",
  },
  { i: 2, time: "0:05", body: "Sign in with one tap." },
  {
    i: 3,
    time: "0:10",
    body: "Open the Servers panel — every running instance, one place.",
  },
  {
    i: 4,
    time: "0:18",
    body: "Spin up a new MCP server in seconds. Pick a region, name it, ship it.",
  },
  {
    i: 5,
    time: "0:26",
    body: "Add tools as apps. Today: Fetch — give your agent web access.",
  },
  {
    i: 6,
    time: "0:35",
    body: "That's it. Star us on GitHub if this saves your week.",
  },
]

function ScriptView() {
  return (
    <div className="flex h-full flex-col gap-2.5 overflow-hidden p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-white">
          Voice-over script
        </span>
        <span className="font-mono text-[10px] text-white/45">
          6 scenes · ~38s · Atlas (warm, US)
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto">
        {SCRIPT_LINES.map((l) => {
          const isHighlighted = l.i === 4
          return (
            <div
              key={l.i}
              className={cn(
                "grid grid-cols-[36px_48px_1fr] items-baseline gap-3 rounded-md border-l-2 px-2.5 py-2",
                isHighlighted
                  ? "border-l-[var(--accent-brand)] bg-white/[0.04]"
                  : "border-l-transparent"
              )}
            >
              <span className="font-mono text-[10px] text-white/40">
                0{l.i}
              </span>
              <span className="font-mono text-[10px] text-white/50">
                {l.time}
              </span>
              <span className="text-[13px] leading-relaxed text-white/90">
                {l.body}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── ThreadRightPanel ────────────────────────────────────────────────────────

export function ThreadRightPanel({
  activeTab,
  onTabChange,
  videoPath,
  videoGeneration,
  projectDomain,
}: ThreadRightPanelProps) {
  const [wsUrl, setWsUrl] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

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

  const handleStaleUrl = useCallback(() => {
    if (!apis) return
    apis.stream.refresh().then((info) => {
      setWsUrl(info?.wsUrl ?? null)
      setRefreshNonce((n) => n + 1)
    })
  }, [])

  const [isExporting, setIsExporting] = useState(false)
  const handleExport = useCallback(async () => {
    if (!videoPath || !apis || isExporting) return
    setIsExporting(true)
    try {
      const dest = await apis.ui.exportToDownloads(videoPath)
      if (dest) console.log("[export] saved to", dest)
    } catch (err) {
      console.error("[export] failed", err)
    } finally {
      setIsExporting(false)
    }
  }, [videoPath, isExporting])

  return (
    <Tabs
      value={activeTab ?? "browser"}
      onValueChange={(v) => onTabChange(v as "browser" | "video" | "script")}
      className="flex h-full flex-col bg-[#0a0a0b]"
    >
      <div className="flex shrink-0 items-end justify-between border-b border-white/[0.05] px-2 pt-2">
        <TabsList variant="line" className="h-9">
          <TabsTrigger value="browser" className="gap-1.5 text-xs">
            <Globe className="size-3" />
            Browser
            <span className="font-mono text-[9.5px] text-white/35">live</span>
          </TabsTrigger>
          <TabsTrigger value="video" className="gap-1.5 text-xs">
            <Video className="size-3" />
            Video
          </TabsTrigger>
          <TabsTrigger value="script" className="gap-1.5 text-xs">
            <Sparkles className="size-3" />
            Script
          </TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-3 pb-1.5">
          {videoPath && (
            <Button
              type="button"
              size="sm"
              onClick={handleExport}
              disabled={isExporting}
              className="h-7 gap-1 px-3 text-[10.5px] font-semibold text-white hover:brightness-110"
              style={{
                background: "var(--accent-brand)",
              }}
            >
              {isExporting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Download className="size-3" />
              )}
              {isExporting ? "Exporting…" : "Export"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onTabChange(null)}
          >
            <X className="size-3" />
          </Button>
        </div>
      </div>

      <TabsContent value="browser" className="flex-1 overflow-hidden">
        <BrowserView
          wsUrl={wsUrl}
          refreshNonce={refreshNonce}
          onStaleUrl={handleStaleUrl}
          domain={projectDomain}
        />
      </TabsContent>

      <TabsContent value="video" className="flex-1 overflow-hidden">
        <VideoView videoPath={videoPath} videoGeneration={videoGeneration} />
      </TabsContent>

      <TabsContent value="script" className="flex-1 overflow-hidden">
        <ScriptView />
      </TabsContent>
    </Tabs>
  )
}
