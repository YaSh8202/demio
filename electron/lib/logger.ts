import log from "electron-log/main"

log.initialize()
log.transports.file.level = "info"
log.transports.console.level =
  process.env.NODE_ENV === "development" ? "debug" : "warn"

export default log
