# Phase 04 — Chat UI

## Prerequisites
Phase 01 (Scaffold) completed.

## Goals
Build the chat interface — the primary control surface where the user talks to the AI agent. Includes message list, input area, and progress cards that show agent activity. By the end, the UI can display messages and render agent progress (tool calls, screenshots), though the actual agent isn't connected yet.

## Tasks

### 4.1 Define message types
- `src/types/index.ts` — define the chat message types:

```ts
type MessageRole = 'user' | 'assistant' | 'system';

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  attachments?: Attachment[];
}

interface ToolCallInfo {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

interface Attachment {
  type: 'image' | 'video' | 'script' | 'json';
  path: string;
  label?: string;
}
```

### 4.2 Chat state management
- `src/hooks/useChat.ts`
- React context + useReducer for chat state
- Actions: addMessage, updateMessage, setStreaming, clearMessages
- Messages array, streaming flag, input value
- Will later be connected to AI SDK's `useChat` or manual streamText handler

### 4.3 ChatPanel component
- `src/components/chat/ChatPanel.tsx`
- Container: fills the left sidebar (280px → expandable to 400px)
- Contains MessageList + MessageInput
- Header with project title / status

### 4.4 MessageList component
- `src/components/chat/MessageList.tsx`
- Scrollable list of messages (use Radix ScrollArea)
- Auto-scroll to bottom on new messages
- User messages: right-aligned, styled differently
- Assistant messages: left-aligned, supports markdown rendering
- Tool call indicators: show which tool was called, its status
- Streaming indicator: typing dots while agent is processing

### 4.5 MessageInput component
- `src/components/chat/MessageInput.tsx`
- Text input (textarea, auto-growing)
- Send button (or Enter to send, Shift+Enter for newline)
- Disabled state while agent is processing
- Placeholder: "Describe your demo..." / "Type a message..."
- File attachment button (for providing screenshots, credentials)

### 4.6 ProgressCard component
- `src/components/chat/ProgressCard.tsx`
- Inline card shown in message list for agent activity
- Variants:
  - **Browser action**: shows tool name + status (e.g., "Opening https://cal.com..." ✓)
  - **Screenshot**: thumbnail preview of captured screenshot
  - **Script**: collapsible view of generated script/scene
  - **Recording**: progress bar for active recording
  - **Voiceover**: audio generation progress
  - **Render**: video encoding progress

### 4.7 Integrate into App layout
- `src/App.tsx` — left sidebar becomes ChatPanel
- Resizable divider between chat and preview panels (optional)

### 4.8 Mock data for development
- Create a mock conversation demonstrating all card types
- Use this during development until the agent is connected in Phase 05

## Files to Create/Modify

```
src/types/index.ts                    # Message types
src/hooks/useChat.ts                  # Chat state management
src/components/chat/
├── ChatPanel.tsx                     # Container
├── MessageList.tsx                   # Scrollable message list
├── MessageInput.tsx                  # Input textarea
└── ProgressCard.tsx                  # Agent activity cards
src/App.tsx                           # Integrate ChatPanel
```

## Verification
- Chat panel renders in left sidebar
- Can type messages and "send" them (appear in message list)
- Mock assistant messages display with markdown formatting
- Progress cards show all variants (browser action, screenshot, script, recording)
- Auto-scroll works on new messages
- Input disables during simulated "processing" state
- Responsive: resizing window keeps layout stable

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app. Phase 01 (scaffold) is complete — the app runs with React + Tailwind in Electron. This is Phase 4: building the chat UI.

The chat panel is the primary control surface where users interact with the AI agent. It lives in the left sidebar and shows the conversation plus agent activity cards.

**Task: Build the chat interface with message list, input, and progress cards.**

### 1. Message types (`src/types/index.ts`)

Define TypeScript types:
```ts
type MessageRole = 'user' | 'assistant' | 'system';

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  attachments?: Attachment[];
}

interface ToolCallInfo {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

interface Attachment {
  type: 'image' | 'video' | 'script' | 'json';
  path: string;
  label?: string;
}
```

### 2. Chat state (`src/hooks/useChat.ts`)

Create a React context + useReducer:
- State: `{ messages: ChatMessage[], isStreaming: boolean, inputValue: string }`
- Actions: `addMessage`, `updateMessage`, `appendToLastMessage`, `setStreaming`, `clearMessages`
- Export `ChatProvider` and `useChat()` hook
- Will be connected to the AI SDK agent loop in Phase 5 — for now, just local state

### 3. ChatPanel (`src/components/chat/ChatPanel.tsx`)

Container component for the left sidebar:
- Takes full height of the sidebar
- Header at top with app name and project status
- MessageList in the middle (scrollable, fills remaining space)
- MessageInput pinned at the bottom
- Dark theme (zinc-900 background, zinc-100 text)

### 4. MessageList (`src/components/chat/MessageList.tsx`)

Scrollable message list:
- Use Radix ScrollArea for custom scrollbar
- Auto-scroll to bottom when new messages arrive
- User messages: right-aligned bubble, blue/indigo accent
- Assistant messages: left-aligned, supports basic markdown (bold, code, lists)
- When a message has `toolCalls`, render ProgressCards inline below the message text
- When a message has `attachments`, render them as thumbnails/links
- Streaming indicator: animated dots when `isStreaming` is true and last message is assistant

### 5. MessageInput (`src/components/chat/MessageInput.tsx`)

Input area:
- Auto-growing textarea (min 1 line, max 5 lines)
- Send button (lucide Send icon) — active when input is non-empty and not streaming
- Enter sends, Shift+Enter adds newline
- Disabled with reduced opacity while streaming
- Placeholder text: "Describe your demo..."

### 6. ProgressCard (`src/components/chat/ProgressCard.tsx`)

Inline card component for agent activity, rendered within MessageList:
- Compact, rounded card with icon + label + status
- Variants based on `toolName`:
  - `run_browser`: Browser icon + command summary + status (spinner/check/x)
  - `screenshot`: Image thumbnail (load from file path via IPC)
  - `writeScript`: Script icon + "Script generated" + collapsible scene list
  - `executeSceneRecording`: Video icon + scene name + progress
  - `generateVoiceover`: Mic icon + scene name + progress
  - `composeScene`: Wand icon + scene name
  - `renderVideo`: Film icon + "Rendering final video..."
- Each card shows elapsed time for completed tool calls

### 7. App integration

Update `src/App.tsx`:
- Left sidebar (w-80 to w-96) → ChatPanel
- Right area → LiveBrowserView (from Phase 3, or placeholder if not done yet)
- Wrap app in `ChatProvider`

### 8. Mock data

Create `src/lib/mockChat.ts` with a sample conversation that exercises all message types and card variants. Load this on dev startup so you can visually test the UI without the agent.

**Design guidelines:**
- Dark theme throughout: zinc-900/950 backgrounds, zinc-100/200 text
- Subtle borders (zinc-800) between sections
- Rounded corners on message bubbles and cards
- Use lucide-react icons: Globe, Camera, FileText, Video, Mic, Wand2, Film, Send, Loader2
- Chat should feel like a conversational interface (think ChatGPT/Claude sidebar style)
- Progress cards should be compact but informative

After implementation:
1. App opens with chat panel on the left
2. Type a message → it appears as a user bubble
3. Mock assistant response appears with progress cards
4. All card variants render correctly
5. Auto-scroll works, input disables during streaming
```
