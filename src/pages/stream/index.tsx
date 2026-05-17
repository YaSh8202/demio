/**
 * StreamPage — Full-screen live browser preview page at /stream.
 *
 * Left panel: agent-browser control buttons for testing.
 * Right panel: LiveBrowserView canvas showing the stream.
 */

import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { LiveBrowserView } from "@/components/preview/LiveBrowserView"
import { apis, isElectron, appInfo } from "@/types/electron-api"
import { useIsFullScreen } from "@/hooks/use-is-full-screen"

export function StreamPage() {
  const [wsUrl, setWsUrl] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [browserResult, setBrowserResult] = useState("")
  const [browserLoading, setBrowserLoading] = useState(false)
  const isMac = appInfo?.platform === "darwin"
  const isFullScreen = useIsFullScreen()

  // Fetch stream URL on mount
  useEffect(() => {
    if (!apis) return

    apis.stream.getUrl().then((url) => {
      setWsUrl(url)

      // If no URL, try enabling the stream
      if (!url) {
        apis?.stream.enable().then((info) => {
          if (info) {
            setWsUrl(info.wsUrl)
          }
        })
      }
    })
  }, [])

  // Re-enable the stream when the renderer's WebSocket gives up reconnecting
  // (daemon was killed by `agent-browser close --all` or crashed). Bump the
  // nonce so the canvas remounts even if the daemon restarted on the same port.
  const handleStaleUrl = useCallback(() => {
    if (!apis) return
    apis.stream.refresh().then((info) => {
      setWsUrl(info?.wsUrl ?? null)
      setRefreshNonce((n) => n + 1)
    })
  }, [])

  const runBrowserCommand = useCallback(async (commands: string[]) => {
    if (!apis) return
    setBrowserLoading(true)
    setBrowserResult("")
    try {
      const result = await apis.agentBrowser.exec(commands)
      const output =
        typeof result.output === "object"
          ? JSON.stringify(result.output, null, 2)
          : result.output
      setBrowserResult(
        [
          `ok: ${result.ok}  exit: ${result.exitCode}  ${result.durationMs}ms`,
          result.error ? `stderr: ${result.error}` : "",
          output,
        ]
          .filter(Boolean)
          .join("\n")
      )
    } catch (err) {
      setBrowserResult(`Error: ${err}`)
    } finally {
      setBrowserLoading(false)
    }
  }, [])

  if (!isElectron) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-muted-foreground">
          Stream preview requires Electron.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-svh flex-col">
      {/* Header — draggable for frameless window */}
      <div
        className={cn(
          "drag-region flex h-12 shrink-0 items-center gap-4 border-b px-4",
          isMac && !isFullScreen && "traffic-light-pad"
        )}
      >
        <Link
          to="/"
          className="no-drag text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          &larr; Back
        </Link>
        <h1 className="text-sm font-medium">Live Browser Preview</h1>
      </div>

      {/* Main content */}
      <div className="no-drag flex min-h-0 flex-1">
        {/* Left panel — controls */}
        <div className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r p-4">
          <div className="space-y-2">
            <h2 className="text-xs font-medium tracking-wider text-neutral-500 uppercase">
              Browser Controls
            </h2>
            <div className="flex flex-col gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={browserLoading}
                onClick={() => runBrowserCommand(["open https://example.com"])}
              >
                Open example.com
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={browserLoading}
                onClick={() => runBrowserCommand(["open https://github.com"])}
              >
                Open github.com
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={browserLoading}
                onClick={() =>
                  runBrowserCommand(["open https://news.ycombinator.com"])
                }
              >
                Open Hacker News
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={browserLoading}
                onClick={() => runBrowserCommand(["snapshot -i --json"])}
              >
                Snapshot (JSON)
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={browserLoading}
                onClick={() => runBrowserCommand(["screenshot"])}
              >
                Screenshot
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={browserLoading}
                onClick={() => runBrowserCommand(["get url"])}
              >
                Get URL
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={browserLoading}
                onClick={() => runBrowserCommand(["get title"])}
              >
                Get Title
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={browserLoading}
                onClick={() => runBrowserCommand(["close"])}
              >
                Close Browser
              </Button>
            </div>
          </div>

          {/* Command result */}
          {browserLoading && (
            <p className="text-xs text-muted-foreground">Running...</p>
          )}
          {browserResult && (
            <div className="space-y-1">
              <h2 className="text-xs font-medium tracking-wider text-neutral-500 uppercase">
                Result
              </h2>
              <pre className="max-h-48 overflow-y-auto rounded bg-muted p-2 text-xs text-muted-foreground">
                {browserResult}
              </pre>
            </div>
          )}

          {/* Stream info */}
          <div className="space-y-1">
            <h2 className="text-xs font-medium tracking-wider text-neutral-500 uppercase">
              Stream
            </h2>
            <p className="font-mono text-xs text-neutral-500">
              {wsUrl ?? "Not connected"}
            </p>
          </div>
        </div>

        {/* Right panel — live preview */}
        <div className="min-w-0 flex-1 p-4">
          <LiveBrowserView
            wsUrl={wsUrl}
            className="h-full w-full"
            onStaleUrl={handleStaleUrl}
            refreshNonce={refreshNonce}
          />
        </div>
      </div>
    </div>
  )
}
