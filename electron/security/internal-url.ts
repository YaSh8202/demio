declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string

const INTERNAL_PROTOCOLS = new Set(["file:", "demio-file:"])

export const isInternalUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl)
    if (INTERNAL_PROTOCOLS.has(parsed.protocol)) return true
    if (
      typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined" &&
      MAIN_WINDOW_VITE_DEV_SERVER_URL &&
      rawUrl.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}
