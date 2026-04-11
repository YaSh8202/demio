/**
 * Chrome installation onboarding component.
 *
 * Shown on first launch if agent-browser cannot find a compatible
 * Chrome/Chromium installation. Guides the user through the
 * `agent-browser install` process.
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { apis, events } from "@/types/electron-api"

type Status =
  | "checking"
  | "not-installed"
  | "installing"
  | "installed"
  | "error"

export function ChromeInstall({
  onComplete,
}: {
  /** Called when Chrome is confirmed available — proceed to main app. */
  onComplete: () => void
}) {
  const [status, setStatus] = useState<Status>("checking")
  const [version, setVersion] = useState<string>()
  const [error, setError] = useState<string>()
  const [progressLines, setProgressLines] = useState<string[]>([])

  // Check Chrome status on mount
  useEffect(() => {
    if (!apis) return

    apis.agentBrowser.checkChromeStatus().then((result) => {
      if (result.available) {
        setVersion(result.version)
        setStatus("installed")
        // Auto-proceed after brief confirmation
        setTimeout(onComplete, 800)
      } else {
        setStatus("not-installed")
        if (result.error) setError(result.error)
      }
    })
  }, [onComplete])

  // Subscribe to install progress events
  useEffect(() => {
    if (!events) return

    const unsub = events.agentBrowser.onInstallProgress((line: string) => {
      setProgressLines((prev) => [...prev.slice(-50), line])
    })

    return unsub
  }, [])

  const handleInstall = async () => {
    if (!apis) return

    setStatus("installing")
    setProgressLines([])
    setError(undefined)

    const result = await apis.agentBrowser.installChrome()

    if (result.ok) {
      setStatus("installed")
      setTimeout(onComplete, 800)
    } else {
      setStatus("error")
      setError(result.message)
    }
  }

  const handleRetry = () => {
    setStatus("not-installed")
    setError(undefined)
    setProgressLines([])
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-md flex-col gap-4 text-center">
        <h1 className="text-lg font-medium">Browser Setup</h1>

        {status === "checking" && (
          <p className="text-sm text-muted-foreground">
            Checking browser availability...
          </p>
        )}

        {status === "not-installed" && (
          <>
            <p className="text-sm text-muted-foreground">
              Demio needs a Chrome browser to automate web interactions. Click
              below to download and install a compatible version.
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button onClick={handleInstall}>Install Chrome</Button>
          </>
        )}

        {status === "installing" && (
          <>
            <p className="text-sm text-muted-foreground">
              Downloading Chrome...
            </p>
            {progressLines.length > 0 && (
              <pre className="max-h-48 overflow-y-auto rounded bg-muted p-3 text-left text-xs text-muted-foreground">
                {progressLines.join("\n")}
              </pre>
            )}
          </>
        )}

        {status === "installed" && (
          <>
            <p className="text-sm text-green-600 dark:text-green-400">
              Chrome is ready
            </p>
            {version && (
              <p className="text-xs text-muted-foreground">{version}</p>
            )}
          </>
        )}

        {status === "error" && (
          <>
            <p className="text-sm text-destructive">
              Chrome installation failed
            </p>
            {error && <p className="text-xs text-destructive/80">{error}</p>}
            {progressLines.length > 0 && (
              <pre className="max-h-32 overflow-y-auto rounded bg-muted p-3 text-left text-xs text-muted-foreground">
                {progressLines.join("\n")}
              </pre>
            )}
            <Button variant="outline" onClick={handleRetry}>
              Try Again
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
