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
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  ThreadHeader,
  type RightPanelTab,
} from "@/components/thread/thread-header"
import { ThreadSidebar } from "@/components/thread/thread-sidebar"
import { ThreadRightPanel } from "@/components/thread/thread-right-panel"
import {
  hasRenderableAssistantParts,
  ThreadAssistantPartRenderer,
} from "@/components/thread/tool-usage"
import { ModelSelectorPopover } from "@/components/model-selector"
import { useActiveThread } from "@/hooks/use-active-thread"
import { useModelStore } from "@/store/model-store"
import { CopyIcon, RefreshCwIcon } from "lucide-react"
import type { UIMessage } from "@electron/store/types"

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

function ThreadMessage({
  message,
  isMessageStreaming,
  onVideoReady,
}: {
  message: UIMessage
  isMessageStreaming: boolean
  onVideoReady?: (absPath: string) => void
}) {
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(getMessageText(message))
  }, [message])

  const hasAnyContent = hasRenderableAssistantParts(message.parts)

  const isThinking =
    message.role === "assistant" && isMessageStreaming && !hasAnyContent

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.role === "user" ? (
          <p className="whitespace-pre-wrap">{getMessageText(message)}</p>
        ) : isThinking ? (
          <Shimmer>Thinking...</Shimmer>
        ) : (
          <ThreadAssistantPartRenderer
            isMessageStreaming={isMessageStreaming}
            messageId={message.id}
            onVideoReady={onVideoReady}
            parts={message.parts}
          />
        )}
      </MessageContent>
      {message.role === "assistant" &&
        !isMessageStreaming &&
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
  }, [zustandModel, selectedModel, setSelectedModel])

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
          project={project}
          isStreaming={isStreaming || isSubmitted}
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
          projectDomain={project?.domain}
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
                          isMessageStreaming={
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

                      {/* Live status pill while streaming */}
                      {(isStreaming || isSubmitted) && (
                        <div className="inline-flex w-fit items-center gap-2 self-start rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 font-mono text-[10.5px] text-white/45">
                          <span className="pulse-dot size-1.5 rounded-full bg-amber-400" />
                          recording agent · live
                        </div>
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
              projectDomain={project?.domain}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  )
}
