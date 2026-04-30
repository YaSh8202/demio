/**
 * WebSocket stream client for agent-browser live preview.
 *
 * Connects to the agent-browser WebSocket stream server and receives
 * live viewport frames (base64 JPEG) from the controlled Chrome instance.
 *
 * Usage:
 * ```ts
 * const stream = new BrowserStream()
 * stream.onFrame((img) => ctx.drawImage(img, 0, 0))
 * stream.onStatus((s) => console.log(s))
 * stream.connect("ws://127.0.0.1:9223")
 * // later:
 * stream.disconnect()
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamStatus = "idle" | "connecting" | "live" | "disconnected"

type FrameCallback = (img: HTMLImageElement) => void
type StatusCallback = (status: StreamStatus) => void
type ViewportCallback = (width: number, height: number) => void
type StaleUrlCallback = () => void

/**
 * Number of failed reconnects (close events without an intervening open) before
 * we give up on the current URL and ask the parent for a fresh one.
 *
 * Three matches the exponential-backoff schedule (1s, 2s, 4s) — by the time
 * we hit it, the daemon has had ~7s to come back on the same port. If it
 * hasn't, the URL is almost certainly stale (different port, or daemon dead).
 */
const MAX_RECONNECT_BEFORE_REFRESH = 3

/** JSON message from the agent-browser WebSocket stream. */
interface StreamMessage {
  type: "status" | "tabs" | "frame"
  // status fields
  connected?: boolean
  viewportWidth?: number
  viewportHeight?: number
  screencasting?: boolean
  // frame fields
  data?: string // base64 JPEG
  metadata?: {
    deviceWidth: number
    deviceHeight: number
    offsetTop: number
    pageScaleFactor: number
    scrollOffsetX: number
    scrollOffsetY: number
    timestamp: number
  }
}

// ---------------------------------------------------------------------------
// BrowserStream
// ---------------------------------------------------------------------------

export class BrowserStream {
  private ws: WebSocket | null = null
  private intentionalClose = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private readonly maxReconnectDelay = 8000
  private failedReconnects = 0

  private frameCallbacks = new Set<FrameCallback>()
  private statusCallbacks = new Set<StatusCallback>()
  private viewportCallbacks = new Set<ViewportCallback>()
  private staleUrlCallbacks = new Set<StaleUrlCallback>()

  private _status: StreamStatus = "idle"
  private _viewportWidth = 1280
  private _viewportHeight = 720
  private _browserConnected = false

  // Reusable Image element for decoding frames — avoids GC pressure
  // from creating a new Image per frame.
  private pendingImage: HTMLImageElement | null = null

  // ---------------------------------------------------------------------------
  // Public getters
  // ---------------------------------------------------------------------------

  get status(): StreamStatus {
    return this._status
  }

  get viewportWidth(): number {
    return this._viewportWidth
  }

  get viewportHeight(): number {
    return this._viewportHeight
  }

  /** Whether the agent-browser daemon has a browser connected. */
  get browserConnected(): boolean {
    return this._browserConnected
  }

  // ---------------------------------------------------------------------------
  // Connect / disconnect
  // ---------------------------------------------------------------------------

  connect(wsUrl: string): void {
    this.intentionalClose = false
    this.clearReconnectTimer()

    // Reset stale-URL counter — a fresh `connect` call (e.g. after refresh)
    // means the parent gave us a new URL and we should retry from scratch.
    this.failedReconnects = 0

    // Close existing connection if any
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }

    this.setStatus("connecting")

    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectDelay = 1000 // reset backoff
      this.failedReconnects = 0
      this.setStatus("live")
    }

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.handleTextMessage(event.data)
      }
    }

    ws.onclose = () => {
      this.ws = null
      if (this.intentionalClose) {
        this.setStatus("idle")
        return
      }

      this.setStatus("disconnected")
      this.failedReconnects += 1

      if (this.failedReconnects >= MAX_RECONNECT_BEFORE_REFRESH) {
        // Stop hammering the dead URL; signal the parent to fetch a new one.
        this.staleUrlCallbacks.forEach((cb) => cb())
        return
      }

      this.scheduleReconnect(wsUrl)
    }

    ws.onerror = () => {
      // onerror is always followed by onclose, so we handle reconnect there
    }
  }

  disconnect(): void {
    this.intentionalClose = true
    this.clearReconnectTimer()
    this.failedReconnects = 0

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }

    this._browserConnected = false
    this.setStatus("idle")
  }

  // ---------------------------------------------------------------------------
  // Event subscriptions (return unsub functions)
  // ---------------------------------------------------------------------------

  onFrame(callback: FrameCallback): () => void {
    this.frameCallbacks.add(callback)
    return () => this.frameCallbacks.delete(callback)
  }

  onStatus(callback: StatusCallback): () => void {
    this.statusCallbacks.add(callback)
    // Fire immediately with current status
    callback(this._status)
    return () => this.statusCallbacks.delete(callback)
  }

  onViewportChange(callback: ViewportCallback): () => void {
    this.viewportCallbacks.add(callback)
    // Fire immediately with current viewport
    callback(this._viewportWidth, this._viewportHeight)
    return () => this.viewportCallbacks.delete(callback)
  }

  /**
   * Fired when reconnect attempts to the current URL have been exhausted.
   * The parent should fetch a fresh URL (e.g. via stream.refresh IPC) and
   * call `connect(newUrl)` to retry.
   */
  onStaleUrl(callback: StaleUrlCallback): () => void {
    this.staleUrlCallbacks.add(callback)
    return () => this.staleUrlCallbacks.delete(callback)
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private setStatus(status: StreamStatus): void {
    if (this._status === status) return
    this._status = status
    this.statusCallbacks.forEach((cb) => cb(status))
  }

  private handleTextMessage(raw: string): void {
    let msg: StreamMessage
    try {
      msg = JSON.parse(raw) as StreamMessage
    } catch {
      return
    }

    switch (msg.type) {
      case "status":
        this._browserConnected = msg.connected ?? false
        if (msg.viewportWidth && msg.viewportHeight) {
          const wChanged = this._viewportWidth !== msg.viewportWidth
          const hChanged = this._viewportHeight !== msg.viewportHeight
          this._viewportWidth = msg.viewportWidth
          this._viewportHeight = msg.viewportHeight
          if (wChanged || hChanged) {
            this.viewportCallbacks.forEach((cb) =>
              cb(this._viewportWidth, this._viewportHeight)
            )
          }
        }
        break

      case "frame":
        if (msg.data) {
          this.decodeFrame(msg.data)
        }
        break

      // "tabs" messages are informational — we ignore them for now
    }
  }

  /**
   * Decode a base64 JPEG frame into an HTMLImageElement and fire callbacks.
   *
   * Uses a single reusable Image element to avoid excessive GC.
   * If a new frame arrives before the previous one finishes loading,
   * the old one is dropped (we always show the latest frame).
   */
  private decodeFrame(base64Data: string): void {
    // If there's already an image loading, abort it by clearing src
    if (this.pendingImage) {
      this.pendingImage.onload = null
      this.pendingImage.onerror = null
    }

    const img = new Image()
    this.pendingImage = img

    img.onload = () => {
      if (this.pendingImage === img) {
        this.pendingImage = null
      }
      this.frameCallbacks.forEach((cb) => cb(img))
    }

    img.onerror = () => {
      if (this.pendingImage === img) {
        this.pendingImage = null
      }
    }

    img.src = `data:image/jpeg;base64,${base64Data}`
  }

  private scheduleReconnect(wsUrl: string): void {
    this.clearReconnectTimer()

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose) {
        this.connect(wsUrl)
      }
    }, this.reconnectDelay)

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay
    )
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
