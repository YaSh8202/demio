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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  ThreadActions,
  ThreadHeader,
  type RightPanelTab,
} from "@/components/thread/thread-header"
import { ThreadSidebar } from "@/components/thread/thread-sidebar"
import { ThreadRightPanel } from "@/components/thread/thread-right-panel"
import { findLatestVideo } from "@/components/thread/present-files-video"
import { RenameThreadDialog } from "@/components/thread/rename-thread-dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  hasRenderableAssistantParts,
  ThreadAssistantPartRenderer,
} from "@/components/thread/tool-usage"
import { SuspensionCard } from "@/components/thread/suspension-card"
import { hasUsage, MessageUsage } from "@/components/thread/message-usage"
import { ModelSelectorPopover } from "@/components/model-selector"
import { useActiveThread } from "@/hooks/use-active-thread"
import { useModelStore } from "@/store/model-store"
import { Button } from "@/components/ui/button"
import { AlertTriangleIcon, CopyIcon, RefreshCwIcon, XIcon } from "lucide-react"
import type { UIMessage } from "@electron/store/types"
import type { WorkflowState } from "@/hooks/use-agent-events"

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
  workflow,
}: {
  message: UIMessage
  isMessageStreaming: boolean
  onVideoReady?: (absPath: string) => void
  workflow?: WorkflowState | null
}) {
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(getMessageText(message))
  }, [message])

  const hasAnyContent = hasRenderableAssistantParts(message.parts)

  const isThinking =
    message.role === "assistant" && isMessageStreaming && !hasAnyContent

  const showCopy = !isMessageStreaming && Boolean(getMessageText(message))
  // Usage arrives on the stream's `finish` chunk, so the badge can appear while
  // `isMessageStreaming` is still true — gate it on the data, not the status.
  // TODO(task-6 follow-up): dead on the controller path — mapped messages
  // (use-active-thread.tsx's `toUIMessage`) never set `metadata`, since
  // `MastraDBMessage` carries no per-message usage/cost equivalent to the old
  // orchestrator's `MessageMetadata`. `useAgentEvents().usage: TokenUsage |
  // null` has thread/run-level usage (from `usage_update`/
  // `displayState.tokenUsage`) if a later task wants to surface it — likely
  // as a thread-level display rather than per-message.
  const showUsage = hasUsage(message.metadata)

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
            workflow={workflow}
          />
        )}
      </MessageContent>
      {message.role === "assistant" && (showCopy || showUsage) && (
        <MessageToolbar>
          <MessageActions>
            {showCopy && (
              <MessageAction tooltip="Copy" onClick={handleCopy}>
                <CopyIcon />
              </MessageAction>
            )}
          </MessageActions>
          {showUsage && <MessageUsage metadata={message.metadata} />}
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
    error,
    suspension,
    workflow,
    respondSuspension,
    input,
    setInput,
    sendMessage,
    retryRun,
    dismissError,
    cancelRun,
    createThread,
    renameThread,
    deleteThread,
    setSelectedModel,
    selectedModel,
    voiceId,
    voiceName,
    isLoaded,
  } = useActiveThread()

  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

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
  // Regenerating writes to the SAME path, so `videoPath` never changes and
  // nothing downstream would re-resolve. Bumping this on every ready signal
  // is what forces a fresh URL (and a fresh <video> element).
  const [videoGeneration, setVideoGeneration] = useState(0)
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

  // Primary source of truth for the preview: read the video straight out of
  // the message data. The `present_files` tool renders inside a collapsed
  // Collapsible, and Radix unmounts collapsed content, so the callback below
  // only fires once the user expands that block — which is why the panel
  // could sit on "Video not ready yet" with the file already on disk.
  const derivedVideo = useMemo(() => findLatestVideo(messages), [messages])

  const effectiveVideoPath = derivedVideo?.path ?? videoPath
  // The tool call id changes on every regeneration, which is exactly the
  // signal the player needs to drop a stale buffer for the same path.
  const effectiveVideoKey = derivedVideo?.key ?? videoGeneration

  const handleVideoReady = useCallback(
    (absPath: string) => {
      setVideoPath(absPath)
      setVideoGeneration((n) => n + 1)
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

  // `useAgentEvents` only distinguishes idle/running/error — the old
  // submitted-vs-streaming split doesn't exist on the controller path (an
  // `agent_start` event fires as soon as the run is accepted, with no
  // separate "queued, no token yet" state). `isRunning` covers both of the
  // old `isStreaming || isSubmitted` call sites.
  const isRunning = status === "running"
  const chatStatus =
    status === "running" ? "streaming" : status === "error" ? "error" : "ready"

  return (
    <SidebarProvider>
      {/* Floating action cluster — fixed top-left, sits above sidebar (z-30 > z-10) */}
      <ThreadActions onNewThread={handleNewThread} />

      {/* Left sidebar — thread list */}
      <Sidebar variant="sidebar" collapsible="offcanvas" side="left">
        <ThreadSidebar
          threads={threads}
          activeThreadId={threadId ?? ""}
          projectId={projectId}
          project={project}
          voiceId={voiceId}
          voiceName={voiceName}
          isStreaming={isRunning}
          onNewThread={handleNewThread}
        />
      </Sidebar>

      {/* Main content area */}
      <SidebarInset className="flex h-svh flex-col overflow-hidden">
        {/* Inline main header — title + more menu + right cluster */}
        <ThreadHeader
          threadTitle={
            thread?.title ?? (threadId ? "Loading..." : "New thread")
          }
          rightPanelTab={rightPanelTab}
          onRightPanelTabChange={handleRightPanelTabChange}
          onRenameThread={threadId ? () => setRenameOpen(true) : undefined}
          onDeleteThread={threadId ? () => setDeleteOpen(true) : undefined}
        />

        <RenameThreadDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          currentTitle={thread?.title ?? ""}
          onSubmit={renameThread}
        />
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete thread?"
          description="This will permanently delete this thread and all its messages. This action cannot be undone."
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={deleteThread}
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
                            isRunning &&
                            msg.role === "assistant" &&
                            index === messages.length - 1
                          }
                          onVideoReady={handleVideoReady}
                          workflow={workflow}
                        />
                      ))}

                      {/* Thinking indicator while running but no assistant message yet */}
                      {isRunning && messages.at(-1)?.role !== "assistant" && (
                        <Message from="assistant">
                          <MessageContent>
                            <Shimmer>Thinking...</Shimmer>
                          </MessageContent>
                        </Message>
                      )}

                      {/* Live status pill while streaming */}
                      {/* {isRunning && (
                        <div className="inline-flex w-fit items-center gap-2 self-start rounded-full px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground">
                          <span className="pulse-dot size-1.5 rounded-full bg-amber-400" />
                          recording agent · live
                        </div>
                      )} */}
                    </>
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>

              {/* Prompt input — replaced by question card when the agent
                  is awaiting an `ask_user` answer. */}
              <div className="shrink-0 p-4">
                {/* A failed run is otherwise invisible — the stream just stops.
                    Without this the thread looks idle and the user has no idea
                    the model call died or that retrying is an option. */}
                {error && (
                  <div className="mx-auto mb-3 flex w-full max-w-3xl items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-destructive">
                        The run stopped unexpectedly
                      </p>
                      <p className="mt-0.5 text-[13px] break-words text-muted-foreground">
                        {error}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={retryRun}
                        className="h-7"
                      >
                        <RefreshCwIcon className="size-3.5" />
                        Retry
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={dismissError}
                        aria-label="Dismiss error"
                        className="size-7"
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                )}

                {suspension ? (
                  <SuspensionCard
                    key={suspension.toolCallId}
                    toolName={suspension.toolName}
                    payload={suspension.payload}
                    onRespond={(resumeData) =>
                      respondSuspension(suspension.toolCallId, resumeData)
                    }
                  />
                ) : (
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
                        <ModelSelectorPopover disabled={isRunning} />
                      </PromptInputTools>
                      <PromptInputSubmit
                        disabled={!input.trim() && chatStatus === "ready"}
                        status={chatStatus === "ready" ? undefined : chatStatus}
                        onStop={cancelRun}
                      />
                    </PromptInputFooter>
                  </PromptInput>
                )}
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
              videoPath={effectiveVideoPath}
              videoGeneration={effectiveVideoKey}
              projectDomain={project?.domain}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  )
}
