// ── Thread Shell ─────────────────────────────────────────────────────────────
//
// Top-level thread UI. Pulls all state from `useActiveThread()` and renders:
//   - Sidebar (thread list)
//   - Header
//   - Conversation (messages + scroll)
//   - Prompt input
//   - Right panel (browser/video preview)
//
// Mirrors the chatbot's ChatShell pattern — no local data fetching, all state
// comes from ActiveThreadProvider via the useActiveThread hook.

import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Sidebar, SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { useDefaultLayout } from "react-resizable-panels"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageToolbar,
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning"
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  ThreadHeader,
  type RightPanelTab,
} from "@/components/thread/thread-header"
import { ThreadSidebar } from "@/components/thread/thread-sidebar"
import { ThreadRightPanel } from "@/components/thread/thread-right-panel"
import { ModelSelectorPopover } from "@/components/model-selector"
import { useActiveThread } from "@/hooks/use-active-thread"
import { useModelStore } from "@/store/model-store"
import { CopyIcon, RefreshCwIcon, FileTextIcon, VideoIcon } from "lucide-react"
import type { UIMessage } from "@electron/store/types"

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

// ── Present Files Output ─────────────────────────────────────────────────────

interface PresentedFile {
  path: string
  kind: "video" | "text" | "error"
  absPath?: string
  sizeBytes?: number
  content?: string
  truncated?: boolean
  error?: string
}

interface PresentFilesOutput {
  files: PresentedFile[]
  hasVideo: boolean
}

function PresentFilesContent({
  output,
  onVideoReady,
}: {
  output: PresentFilesOutput
  onVideoReady?: (absPath: string) => void
}) {
  const videoTriggered = useRef(false)

  useEffect(() => {
    if (videoTriggered.current || !onVideoReady) return
    const videoFile = output.files.find(
      (f) => f.kind === "video" && f.absPath
    )
    if (videoFile?.absPath) {
      videoTriggered.current = true
      onVideoReady(videoFile.absPath)
    }
  }, [output, onVideoReady])

  return (
    <div className="flex flex-col gap-3">
      {output.files.map((file) => {
        if (file.kind === "video") {
          const sizeMB = file.sizeBytes
            ? (file.sizeBytes / 1_048_576).toFixed(1)
            : "?"
          return (
            <div
              key={file.path}
              className="flex items-center gap-2 rounded-md border border-sidebar-border bg-muted/50 px-3 py-2"
            >
              <VideoIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {file.path}
              </span>
              <span className="text-xs text-muted-foreground">
                {sizeMB} MB
              </span>
            </div>
          )
        }

        if (file.kind === "text") {
          return (
            <div key={file.path} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileTextIcon className="size-3" />
                {file.path}
                {file.truncated && (
                  <span className="text-yellow-500">(truncated)</span>
                )}
              </div>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
                {file.content}
              </pre>
            </div>
          )
        }

        // Error
        return (
          <div
            key={file.path}
            className="text-sm text-destructive"
          >
            {file.path}: {file.error}
          </div>
        )
      })}
    </div>
  )
}

// ── Message Renderer ────────────────────────────────────────────────────────

function ThreadMessage({
  message,
  isStreaming,
  onVideoReady,
}: {
  message: UIMessage
  isStreaming: boolean
  onVideoReady?: (absPath: string) => void
}) {
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(getMessageText(message))
  }, [message])

  const parts = message.parts.map((part, index) => {
    const { type } = part
    const key = `message-${message.id}-part-${index}`

    if (type === "reasoning") {
      const reasoningText = (part as { text?: string }).text
      if (!reasoningText) return null

      return (
        <Reasoning isStreaming={isStreaming} key={key}>
          <ReasoningTrigger />
          <ReasoningContent>{reasoningText}</ReasoningContent>
        </Reasoning>
      )
    }

    if (type === "text") {
      const text = (part as { text?: string }).text
      if (!text) return null

      return (
        <MessageResponse isAnimating={isStreaming} key={key}>
          {text}
        </MessageResponse>
      )
    }

    const t = type as string
    if (t.startsWith("tool-") || t === "dynamic-tool") {
      const raw = part as {
        toolCallId: string
        toolName?: string
        state: string
        input?: unknown
        output?: unknown
        errorText?: string
      }
      const toolName = raw.toolName ?? t.replace(/^tool-/, "")

      // Custom rendering for present_files
      if (
        toolName === "present_files" &&
        raw.state === "output-available" &&
        raw.output
      ) {
        const pfOutput = raw.output as PresentFilesOutput
        return (
          <PresentFilesContent
            key={raw.toolCallId}
            output={pfOutput}
            onVideoReady={onVideoReady}
          />
        )
      }

      return (
        <Tool key={raw.toolCallId}>
          <ToolHeader
            type={`tool-${toolName}` as `tool-${string}`}
            state={
              raw.state as
                | "input-available"
                | "input-streaming"
                | "output-available"
                | "output-error"
                | "output-denied"
                | "approval-requested"
                | "approval-responded"
            }
          />
          <ToolContent>
            {raw.input !== undefined && <ToolInput input={raw.input} />}
            {(raw.output !== undefined || raw.errorText) && (
              <ToolOutput output={raw.output} errorText={raw.errorText} />
            )}
          </ToolContent>
        </Tool>
      )
    }

    return null
  })

  const hasAnyContent = message.parts.some(
    (part) =>
      (part.type === "text" &&
        (part as { text?: string }).text?.trim().length) ||
      (part.type === "reasoning" &&
        (part as { text?: string }).text?.trim().length) ||
      (part.type as string).startsWith("tool-") ||
      part.type === "dynamic-tool"
  )

  const isThinking =
    message.role === "assistant" && isStreaming && !hasAnyContent

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.role === "user" ? (
          <p className="whitespace-pre-wrap">{getMessageText(message)}</p>
        ) : isThinking ? (
          <Shimmer>Thinking...</Shimmer>
        ) : (
          parts
        )}
      </MessageContent>
      {message.role === "assistant" &&
        !isStreaming &&
        getMessageText(message) && (
          <MessageToolbar>
            <MessageActions>
              <MessageAction tooltip="Copy" onClick={handleCopy}>
                <CopyIcon />
              </MessageAction>
              <MessageAction tooltip="Regenerate">
                <RefreshCwIcon />
              </MessageAction>
            </MessageActions>
          </MessageToolbar>
        )}
    </Message>
  )
}

// ── Thread Shell ─────────────────────────────────────────────────────────────

export function ThreadShell() {
  const {
    projectId,
    threadId,
    project,
    thread,
    threads,
    messages,
    status,
    input,
    setInput,
    sendMessage,
    cancelRun,
    createThread,
    deleteThread,
    setSelectedModel,
    selectedModel,
    isLoaded,
  } = useActiveThread()

  // Sync Zustand model store → project meta
  const zustandModel = useModelStore((s) => s.selectedModel)
  useEffect(() => {
    if (zustandModel && zustandModel !== selectedModel) {
      setSelectedModel(zustandModel)
    }
  }, [zustandModel])

  // Right panel state
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(null)
  const [videoPath, setVideoPath] = useState<string | null>(null)
  const rightPanelRef = useRef<PanelImperativeHandle>(null)

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "thread-panels",
  })

  const handleRightPanelTabChange = useCallback((tab: RightPanelTab) => {
    setRightPanelTab((prev) => {
      if (tab && !prev) {
        rightPanelRef.current?.resize("40%")
      } else if (!tab) {
        rightPanelRef.current?.collapse()
      }
      return tab
    })
  }, [])

  const handleVideoReady = useCallback(
    (absPath: string) => {
      setVideoPath(absPath)
      handleRightPanelTabChange("video")
    },
    [handleRightPanelTabChange]
  )

  const handleSubmit = useCallback(
    async (promptMessage: PromptInputMessage) => {
      const text = promptMessage.text.trim()
      if (!text) return
      await sendMessage(text)
    },
    [sendMessage]
  )

  // If we arrived here with a pending prompt from the dashboard, auto-send
  // it once the thread is loaded. Clear route state so refresh doesn't resend.
  const location = useLocation()
  const navigate = useNavigate()
  const pendingPrompt = (location.state as { pendingPrompt?: string } | null)
    ?.pendingPrompt
  const pendingSentRef = useRef(false)
  useEffect(() => {
    if (!pendingPrompt || !isLoaded || pendingSentRef.current) return
    pendingSentRef.current = true
    navigate(location.pathname, { replace: true, state: null })
    void sendMessage(pendingPrompt)
  }, [pendingPrompt, isLoaded, sendMessage, navigate, location.pathname])

  const handleNewThread = useCallback(async () => {
    await createThread()
  }, [createThread])

  const isStreaming = status === "streaming"
  const isSubmitted = status === "submitted"
  const chatStatus =
    status === "streaming"
      ? "streaming"
      : status === "submitted"
        ? "submitted"
        : status === "error"
          ? "error"
          : "ready"

  return (
    <SidebarProvider>
      {/* Left sidebar — thread list */}
      <Sidebar variant="sidebar" collapsible="offcanvas" side="left">
        <ThreadSidebar
          threads={threads}
          activeThreadId={threadId ?? ""}
          projectId={projectId}
          onNewThread={handleNewThread}
        />
      </Sidebar>

      {/* Main content area */}
      <SidebarInset className="flex h-svh flex-col overflow-hidden">
        {/* Top header bar */}
        <ThreadHeader
          threadTitle={
            thread?.title ?? (threadId ? "Loading..." : "New thread")
          }
          projectName={project?.name ?? ""}
          rightPanelTab={rightPanelTab}
          onRightPanelTabChange={handleRightPanelTabChange}
          onNewThread={handleNewThread}
          onDeleteThread={threadId ? deleteThread : undefined}
        />

        {/* Content area: conversation + optional right panel */}
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          {/* Center — conversation + prompt input */}
          <ResizablePanel id="conversation" defaultSize="100%" minSize="35%">
            <div className="flex h-full flex-col">
              {/* Messages */}
              <Conversation className="flex-1">
                <ConversationContent className="mx-auto w-full max-w-3xl">
                  {!isLoaded ? (
                    <ConversationEmptyState
                      title="Loading..."
                      description="Fetching messages"
                    />
                  ) : messages.length === 0 ? (
                    <ConversationEmptyState
                      title="What can I help with?"
                      description="Send a message to start the conversation"
                    />
                  ) : (
                    <>
                      {messages.map((msg, index) => (
                        <ThreadMessage
                          key={msg.id}
                          message={msg}
                          isStreaming={
                            (isStreaming || isSubmitted) &&
                            msg.role === "assistant" &&
                            index === messages.length - 1
                          }
                          onVideoReady={handleVideoReady}
                        />
                      ))}

                      {/* Thinking indicator when submitted but no assistant message yet */}
                      {isSubmitted && messages.at(-1)?.role !== "assistant" && (
                        <Message from="assistant">
                          <MessageContent>
                            <Shimmer>Thinking...</Shimmer>
                          </MessageContent>
                        </Message>
                      )}
                    </>
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>

              {/* Prompt input */}
              <div className="shrink-0 p-4">
                <PromptInput
                  onSubmit={handleSubmit}
                  className="mx-auto w-full max-w-3xl"
                >
                  <PromptInputBody>
                    <PromptInputTextarea
                      value={input}
                      onChange={(e) => setInput(e.currentTarget.value)}
                      placeholder="Ask for follow-up changes"
                    />
                  </PromptInputBody>
                  <PromptInputFooter>
                    <PromptInputTools>
                      <ModelSelectorPopover
                        disabled={isStreaming || isSubmitted}
                      />
                    </PromptInputTools>
                    <PromptInputSubmit
                      disabled={!input.trim() && chatStatus === "ready"}
                      status={chatStatus === "ready" ? undefined : chatStatus}
                      onStop={cancelRun}
                    />
                  </PromptInputFooter>
                </PromptInput>
              </div>
            </div>
          </ResizablePanel>

          {/* Resize handle + right panel */}
          <ResizableHandle withHandle className="no-drag" />
          <ResizablePanel
            id="right-panel"
            panelRef={rightPanelRef}
            defaultSize="0%"
            minSize="20%"
            maxSize="65%"
            collapsible
            collapsedSize="0%"
            onResize={(size) => {
              if (size.asPercentage === 0 && rightPanelTab) {
                setRightPanelTab(null)
              } else if (size.asPercentage > 0 && !rightPanelTab) {
                setRightPanelTab("browser")
              }
            }}
            className="border-l border-sidebar-border"
          >
            <ThreadRightPanel
              activeTab={rightPanelTab}
              onTabChange={handleRightPanelTabChange}
              videoPath={videoPath}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  )
}
