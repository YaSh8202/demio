import { useEffect, useState } from "react"
import { apis, events } from "@/types/electron-api"

export function useIsFullScreen(): boolean {
  const [isFullScreen, setIsFullScreen] = useState(false)

  useEffect(() => {
    let mounted = true
    apis?.ui.isFullScreen().then((v) => {
      if (mounted) setIsFullScreen(v)
    })
    const unsub = events?.ui.onFullScreenChanged((v: boolean) => {
      setIsFullScreen(v)
    })
    return () => {
      mounted = false
      unsub?.()
    }
  }, [])

  return isFullScreen
}
