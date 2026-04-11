import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  apis,
  events,
  appInfo,
  sharedStorage,
  isElectron,
} from "@/types/electron-api"

export function App() {
  const [clipboardText, setClipboardText] = useState("")
  const [isMaximized, setIsMaximized] = useState(false)
  const [isFocused, setIsFocused] = useState(true)
  const [counter, setCounter] = useState<number>(0)

  // Subscribe to window events
  useEffect(() => {
    if (!events || !apis) return

    // Get initial state
    apis.ui.isMaximized().then(setIsMaximized)

    // Subscribe to maximize/focus changes
    const unsubMax = events.ui.onMaximized(setIsMaximized)
    const unsubFocus = events.ui.onFocusChanged(setIsFocused)

    return () => {
      unsubMax()
      unsubFocus()
    }
  }, [])

  // Watch shared storage for a counter value
  useEffect(() => {
    if (!sharedStorage) return

    const unsub = sharedStorage.watch("demo:counter", (value) => {
      setCounter(typeof value === "number" ? value : 0)
    })

    return unsub
  }, [])

  const handleReadClipboard = async () => {
    if (!apis) return
    const text = await apis.clipboard.readText()
    setClipboardText(text)
  }

  const handleWriteClipboard = async () => {
    if (!apis) return
    await apis.clipboard.writeText("Hello from Demio IPC!")
  }

  const handleOpenExternal = async () => {
    if (!apis) return
    await apis.ui.openExternal("https://github.com")
  }

  const handleToggleMaximize = async () => {
    if (!apis) return
    await apis.ui.toggleMaximize()
  }

  const handleIncrementCounter = () => {
    if (!sharedStorage) return
    sharedStorage.set("demo:counter", counter + 1)
  }

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-lg min-w-0 flex-col gap-6 text-sm leading-loose">
        <div>
          <h1 className="text-lg font-medium">Demio IPC Demo</h1>
          {isElectron ? (
            <p className="text-muted-foreground">
              Running in Electron v{appInfo?.version} on {appInfo?.platform}
              {" · "}
              Window: {appInfo?.windowName}
            </p>
          ) : (
            <p className="text-muted-foreground">Not running in Electron</p>
          )}
        </div>

        {/* Window State */}
        <div className="space-y-2">
          <h2 className="font-medium">Window State (events)</h2>
          <div className="flex gap-2 text-xs">
            <span
              className={
                isMaximized ? "text-green-500" : "text-muted-foreground"
              }
            >
              {isMaximized ? "Maximized" : "Normal"}
            </span>
            <span>·</span>
            <span
              className={isFocused ? "text-green-500" : "text-muted-foreground"}
            >
              {isFocused ? "Focused" : "Blurred"}
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={handleToggleMaximize}>
            {isMaximized ? "Restore" : "Maximize"}
          </Button>
        </div>

        {/* Clipboard */}
        <div className="space-y-2">
          <h2 className="font-medium">Clipboard (handlers)</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleReadClipboard}>
              Read Clipboard
            </Button>
            <Button size="sm" variant="outline" onClick={handleWriteClipboard}>
              Write to Clipboard
            </Button>
          </div>
          {clipboardText && (
            <pre className="rounded bg-muted p-2 text-xs text-muted-foreground">
              {clipboardText}
            </pre>
          )}
        </div>

        {/* Shared Storage */}
        <div className="space-y-2">
          <h2 className="font-medium">Shared Storage</h2>
          <p className="text-xs text-muted-foreground">
            Counter: <span className="font-mono">{counter}</span>
          </p>
          <Button size="sm" variant="outline" onClick={handleIncrementCounter}>
            Increment Counter
          </Button>
        </div>

        {/* Shell */}
        <div className="space-y-2">
          <h2 className="font-medium">Shell</h2>
          <Button size="sm" variant="outline" onClick={handleOpenExternal}>
            Open GitHub
          </Button>
        </div>

        <div className="font-mono text-xs text-muted-foreground">
          (Press <kbd>d</kbd> to toggle dark mode)
        </div>
      </div>
    </div>
  )
}

export default App
