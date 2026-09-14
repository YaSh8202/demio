import log from "electron-log/main"

// `spyRendererConsole` forwards renderer console output into this logger so
// the player's `[player] error {code, message, networkState}` line lands in
// main.log instead of existing only in DevTools. It must be THIS option and
// not a hand-rolled `webContents.on("console-message")`: in dev the `ipc`
// transport echoes every main-process line back into the renderer console,
// and a naive hook re-logs the echo — each round trip doubles and the app
// hangs within seconds. electron-log tags spied messages with
// `processType: "renderer"` and the ipc transport skips those.
log.initialize({ spyRendererConsole: true })
// Only the renderer's warnings and errors are worth keeping — its info/debug
// chatter (Vite HMR, React dev notices) would otherwise fill main.log.
log.hooks.push((message) => {
  if (message.variables?.processType !== "renderer") return message
  return message.level === "warn" || message.level === "error" ? message : false
})
// The ipc transport echoes main-process lines into the renderer console in
// dev (once per webContents, so DevTools sees each line three times). With
// the spy above those echoes come straight back as `[renderer]` lines —
// filtered out of the loop by their processType, but still a duplicate per
// webContents in main.log. main.log is the record; DevTools can do without.
log.transports.ipc.level = false
log.transports.file.level = "info"
log.transports.console.level =
  process.env.NODE_ENV === "development" ? "debug" : "warn"

export default log
