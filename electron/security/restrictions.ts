import { app } from "electron"
import log from "../lib/logger"
import { isInternalUrl } from "./internal-url"
import { openExternalSafely } from "./open-external"

export const registerSecurityRestrictions = () => {
  app.on("web-contents-created", (_, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (isInternalUrl(url)) return
      event.preventDefault()
      openExternalSafely(url).catch((err) =>
        log.error("[security] will-navigate openExternal failed", err)
      )
    })

    contents.setWindowOpenHandler(({ url }) => {
      if (!isInternalUrl(url)) {
        openExternalSafely(url).catch((err) =>
          log.error("[security] setWindowOpenHandler openExternal failed", err)
        )
      }
      return { action: "deny" }
    })
  })
}
