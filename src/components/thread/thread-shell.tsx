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
import { CopyIcon, RefreshCwIcon } from "lucide-react"
import type { UIMessage } from "@electron/store/types"

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

function getMessageReasoning(message: UIMessage): string {
  return message.parts
    .filter(
      (p): p is { type: "reasoning"; text: string } => p.type === "reasoning"
    )
    .map((p) => p.text)
    .join("")
}

// ── Message Renderer ─────────────────────────────────────────────────────────

function ThreadMessage({
  message,
  isStreaming,
}: {
  message: UIMessage
  isStreaming: boolean
}) {
  const text = getMessageText(message)
  const reasoning = getMessageReasoning(message)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
  }, [text])

  // Tool parts — any part whose type starts with "tool-", plus "dynamic-tool"
  const toolParts = message.parts
    .filter((p) => {
      const t = (p as { type?: string }).type
      return !!t && (t.startsWith("tool-") || t === "dynamic-tool")
    })
    .map((p) => {
      const raw = p as {
        type: string
        toolCallId: string
        toolName?: string
        state: string
        input?: unknown
        output?: unknown
        errorText?: string
      }
      return {
        ...raw,
        toolName: raw.toolName ?? raw.type.replace(/^tool-/, ""),
      }
    })

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.role === "user" ? (
          <p className="whitespace-pre-wrap">{text}</p>
        ) : (
          <>
            {/* Reasoning */}
            {reasoning && (
              <Reasoning isStreaming={isStreaming}>
                <ReasoningTrigger />
                <ReasoningContent>{reasoning}</ReasoningContent>
              </Reasoning>
            )}

            {/* Tool invocations */}
            {toolParts.map((part) => (
              <Tool key={part.toolCallId}>
                <ToolHeader
                  type={`tool-${part.toolName}` as `tool-${string}`}
                  state={
                    part.state as
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
                  {part.input !== undefined && <ToolInput input={part.input} />}
                  {(part.output !== undefined || part.errorText) && (
                    <ToolOutput
                      output={part.output}
                      errorText={part.errorText}
                    />
                  )}
                </ToolContent>
              </Tool>
            ))}

            {/* Text response */}
            {text ? (
              <MessageResponse isAnimating={isStreaming}>
                {text}
              </MessageResponse>
            ) : (
              // No text yet — show shimmer while streaming
              isStreaming &&
              !reasoning &&
              toolParts.length === 0 && <Shimmer>Thinking...</Shimmer>
            )}
          </>
        )}
      </MessageContent>
      {message.role === "assistant" && !isStreaming && text && (
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
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  )
}
