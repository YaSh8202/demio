import { shell } from "electron"
import log from "../lib/logger"

const DEFAULT_ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

export const isAllowedExternalUrl = (rawUrl: string) => {
  try {
    return DEFAULT_ALLOWED_PROTOCOLS.has(
      new URL(rawUrl).protocol.toLowerCase()
    )
  } catch (error) {
    log.warn("[security] Failed to parse external URL", rawUrl, error)
    return false
  }
}

export const openExternalSafely = async (rawUrl: string) => {
  if (!isAllowedExternalUrl(rawUrl)) {
    log.warn("[security] Blocked external URL:", rawUrl)
    return
  }
  try {
    await shell.openExternal(rawUrl)
  } catch (error) {
    log.error("[security] shell.openExternal failed:", rawUrl, error)
  }
}
