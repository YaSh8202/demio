# Phase 03 — Live Browser Preview

## Prerequisites
Phase 02 (agent-browser layer) completed — `execAgentBrowser()` works, daemon lifecycle managed.

## Goals
Show a live view of the agent-browser-controlled Chrome inside the Electron app's preview panel. Use agent-browser's WebSocket streaming to render frames onto a canvas. By the end, when the agent opens a URL, the user sees it live in the app.

## Tasks

### 3.1 Enable streaming on app start
- In `electron/main.ts`, after daemon init: run `agent-browser stream enable --port 9223`
- Parse `agent-browser stream status --json` to get the actual bound port and WebSocket URL
- Store the stream URL in app state, expose via IPC to renderer
- Handle port conflicts (retry with different port)

### 3.2 WebSocket stream client
- `src/lib/agentBrowser/stream.ts`
- Connect to the agent-browser WebSocket stream
- Receive frame data (likely base64 PNG/JPEG or raw pixels)
- Decode frames into ImageBitmap or drawable format
- Handle reconnection on disconnect
- Expose: `connect(wsUrl)`, `disconnect()`, `onFrame(callback)`

### 3.3 LiveBrowserView component
- `src/components/preview/LiveBrowserView.tsx`
- Canvas element that renders incoming frames from the WebSocket stream
- Scale to fit container while maintaining 1280x800 aspect ratio
- Show connection status (connecting, live, disconnected)
- Show placeholder when no browser session is active
- Handle resize events

### 3.4 Integrate into App layout
- `src/App.tsx` — replace the right-side placeholder with `LiveBrowserView`
- Pass the stream WebSocket URL from main process via IPC
- Show the preview panel during discovery and recording phases

### 3.5 Stream lifecycle IPC
- `src/types/ipc.ts` — add channels:
  - `stream:url` — get the current WebSocket stream URL
  - `stream:enable` — start streaming
  - `stream:disable` — stop streaming
- `electron/ipc/handlers.ts` — implement handlers

### 3.6 Handle stream enable/disable on app lifecycle
- Enable stream on app start (after daemon ready)
- Disable stream on app quit (before daemon stop)
- Re-enable stream if it drops (agent-browser restart)

## Files to Create/Modify

```
src/lib/agentBrowser/stream.ts        # WebSocket stream client
src/components/preview/LiveBrowserView.tsx  # Canvas preview component
electron/main.ts                       # Stream enable on startup
electron/ipc/handlers.ts              # Stream IPC handlers
src/types/ipc.ts                      # Stream channel types
src/App.tsx                           # Integrate preview panel
```

## Verification
- `npm run dev` → app opens with preview panel on the right
- From main process: `execAgentBrowser(['open https://example.com'])` → preview shows example.com loading
- Navigate to different pages → preview updates in near-real-time
- Close browser → preview shows "No active session" placeholder
- Reconnection: kill and restart stream → preview reconnects automatically

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phases 01-02 are complete: the app scaffold works and `execAgentBrowser()` can run any agent-browser CLI command. This is Phase 3: live browser preview.

agent-browser has a built-in WebSocket streaming feature:
- `agent-browser stream enable --port 9223` — starts a WebSocket server
- `agent-browser stream status --json` — returns `{ enabled, port, wsUrl, ... }`
- `agent-browser stream disable` — stops streaming

The WebSocket streams live viewport frames so you can observe the browser remotely.

**Task: Build a live preview panel that shows the agent-browser-controlled Chrome inside the Electron app.**

### 1. Stream setup in main process

In `electron/main.ts`, after the daemon is initialized:
- Run `agent-browser stream enable --port 9223`
- Parse `agent-browser stream status --json` to get the WebSocket URL
- Store the URL for IPC access
- If port 9223 is taken, try 9224, 9225, etc.
- On app quit: `agent-browser stream disable`

### 2. `src/lib/agentBrowser/stream.ts` — WebSocket client

Create a stream client class:
```ts
class BrowserStream {
  connect(wsUrl: string): void
  disconnect(): void
  onFrame(callback: (frame: ImageBitmap | HTMLImageElement) => void): void
  onStatus(callback: (status: 'connecting' | 'live' | 'disconnected') => void): void
}
```
- Connect to the WebSocket URL
- Receive frame data and convert to drawable format
- Auto-reconnect with exponential backoff on disconnect
- Clean disconnect on `disconnect()` call

### 3. `src/components/preview/LiveBrowserView.tsx`

React component:
- Takes `wsUrl` prop (from IPC)
- Uses a `<canvas>` element to render frames
- Creates a `BrowserStream` instance, draws each frame to canvas
- Maintains 1280x800 aspect ratio, scales to fit container with `object-fit: contain` behavior
- Shows status overlay: "Connecting...", "Live", "Disconnected — Reconnecting..."
- Shows a placeholder with instructions when no browser session exists
- Handles container resize via ResizeObserver
- Cleans up WebSocket on unmount

### 4. App layout integration

Update `src/App.tsx`:
- Right panel (main area) shows `LiveBrowserView`
- Get stream URL from main process via IPC on mount
- Pass URL to LiveBrowserView

### 5. IPC channels

Add to `src/types/ipc.ts`:
- `stream:get-url` → returns current WebSocket URL
- `stream:enable` → enables streaming, returns URL
- `stream:disable` → stops streaming

Register handlers in `electron/ipc/handlers.ts`.
Expose in `electron/preload.ts`.

**Notes:**
- The stream protocol may send frames as base64-encoded images or binary data — handle both
- Keep the canvas rendering efficient (requestAnimationFrame, avoid unnecessary redraws)
- Stream URL should be fetched once on app mount, not polled
- Dark theme: placeholder should match the app's dark background

After implementation:
1. `npm run dev` → app shows preview panel with "No session" placeholder
2. Open browser from main process → preview shows the page live
3. Navigate around → preview updates
4. Close browser → preview shows placeholder again
```
