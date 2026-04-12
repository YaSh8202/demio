import { useRef, useState, useEffect, useCallback } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { generateId } from "ai"
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
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import {
  ThreadHeader,
  type RightPanelTab,
} from "@/components/thread/thread-header"
import { ThreadSidebar } from "@/components/thread/thread-sidebar"
import { ThreadRightPanel } from "@/components/thread/thread-right-panel"
import { apis, events } from "@/types/electron-api"
import type {
  UIMessage,
  StoredThread,
  StoredProject,
  MessageMetadata,
} from "../../../../electron/store/types"
import { CopyIcon, RefreshCwIcon } from "lucide-react"

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

function createUserMessage(text: string): UIMessage {
  const metadata: MessageMetadata = {
    modelId: null,
    totalUsage: null,
    cost: null,
    status: null,
    messageTokens: 0,
  }

  return {
    id: generateId(),
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
    metadata,
  }
}

// ── ThreadPage (wrapper) ─────────────────────────────────────────────────────
// Key-based remount ensures clean state when navigating between threads.

export function ThreadPage() {
  const { projectId, threadId } = useParams<{
    projectId: string
    threadId: string
  }>()

  if (!projectId || !threadId) {
    return (
      <div className="flex h-svh items-center justify-center">
        <p className="text-muted-foreground">Invalid project or thread.</p>
      </div>
    )
  }

  return (
    <ThreadPageInner
      key={`${projectId}:${threadId}`}
      projectId={projectId}
      threadId={threadId}
    />
  )
}

// ── ThreadPageInner ──────────────────────────────────────────────────────────

function ThreadPageInner({
  projectId,
  threadId,
}: {
  projectId: string
  threadId: string
}) {
  const navigate = useNavigate()

  // ── State ────────────────────────────────────────────────────────────────
  const [project, setProject] = useState<StoredProject | null>(null)
  const [thread, setThread] = useState<StoredThread | null>(null)
  const [threads, setThreads] = useState<StoredThread[]>([])
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(null)
  const rightPanelRef = useRef<PanelImperativeHandle>(null)

  // Persist resize layout to localStorage
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "thread-panels",
  })

  // Sync right panel collapse state with tab selection
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

  // ── Load project, thread, threads list, and messages on mount ────────────
  useEffect(() => {
    if (!apis) return

    let cancelled = false

    Promise.all([
      apis.store.getProject(projectId),
      apis.store.getThread(projectId, threadId),
      apis.store.listThreads(projectId),
      apis.store.getMessages(projectId, threadId),
    ]).then(([proj, t, threadList, msgs]) => {
      if (cancelled) return
      setProject(proj?.project ?? null)
      setThread(t)
      setThreads(threadList)
      setMessages(msgs as UIMessage[])
      setLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [projectId, threadId])

  // ── Subscribe to thread list changes ─────────────────────────────────────
  useEffect(() => {
    const unsub = events?.store.onThreadsChanged(
      (evtProjectId: string, updatedThreads: StoredThread[]) => {
        if (evtProjectId === projectId) {
          setThreads(updatedThreads)
        }
      }
    )
    return () => unsub?.()
  }, [projectId])

  // ── Subscribe to new messages (multi-window sync) ────────────────────────
  useEffect(() => {
    const unsub = events?.store.onMessageAppended(
      (evtProjectId: string, evtThreadId: string, message: UIMessage) => {
        if (evtProjectId === projectId && evtThreadId === threadId) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === message.id)) return prev
            return [...prev, message]
          })
        }
      }
    )
    return () => unsub?.()
  }, [projectId, threadId])

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (promptMessage: PromptInputMessage) => {
      const text = promptMessage.text.trim()
      if (!text || !apis) return

      const userMessage = createUserMessage(text)

      // Optimistic UI update
      setMessages((prev) => [...prev, userMessage])
      setInput("")

      // Persist to store
      await apis.store.appendMessage(projectId, threadId, userMessage)
    },
    [projectId, threadId]
  )

  const handleNewThread = useCallback(async () => {
    if (!apis) return
    const newThread = await apis.store.createThread(projectId)
    navigate(`/projects/${projectId}/threads/${newThread.id}`)
  }, [projectId, navigate])

  const handleDeleteThread = useCallback(async () => {
    if (!apis) return
    await apis.store.deleteThread(projectId, threadId)
    // Navigate to first remaining thread, or back to dashboard
    const remaining = threads.filter((t) => t.id !== threadId)
    if (remaining.length > 0) {
      navigate(`/projects/${projectId}/threads/${remaining[0].id}`)
    } else {
      navigate("/")
    }
  }, [projectId, threadId, threads, navigate])

  const handleCopyMessage = useCallback((text: string) => {
    navigator.clipboard.writeText(text)
  }, [])

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SidebarProvider>
      {/* Left sidebar — thread list */}
      <Sidebar variant="sidebar" collapsible="offcanvas" side="left">
        <ThreadSidebar
          threads={threads}
          activeThreadId={threadId}
          projectId={projectId}
          onNewThread={handleNewThread}
        />
      </Sidebar>

      {/* Main content area (inset from sidebar) */}
      <SidebarInset className="flex h-svh flex-col overflow-hidden">
        {/* Top header bar */}
        <ThreadHeader
          threadTitle={thread?.title ?? "Loading..."}
          projectName={project?.name ?? ""}
          rightPanelTab={rightPanelTab}
          onRightPanelTabChange={handleRightPanelTabChange}
          onNewThread={handleNewThread}
          onDeleteThread={handleDeleteThread}
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
                  {!loaded ? (
                    <ConversationEmptyState
                      title="Loading..."
                      description="Fetching messages"
                    />
                  ) : messages.length === 0 ? (
                    <ConversationEmptyState
                      title="No messages yet"
                      description="Send a message to start the conversation"
                    />
                  ) : (
                    messages.map((msg) => (
                      <Message key={msg.id} from={msg.role}>
                        <MessageContent>
                          {msg.role === "assistant" ? (
                            <MessageResponse>
                              {getMessageText(msg)}
                            </MessageResponse>
                          ) : (
                            <p className="whitespace-pre-wrap">
                              {getMessageText(msg)}
                            </p>
                          )}
                        </MessageContent>
                        {msg.role === "assistant" && (
                          <MessageToolbar>
                            <MessageActions>
                              <MessageAction
                                tooltip="Copy"
                                onClick={() =>
                                  handleCopyMessage(getMessageText(msg))
                                }
                              >
                                <CopyIcon />
                              </MessageAction>
                              <MessageAction tooltip="Regenerate">
                                <RefreshCwIcon />
                              </MessageAction>
                            </MessageActions>
                          </MessageToolbar>
                        )}
                      </Message>
                    ))
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
                    <PromptInputTools />
                    <PromptInputSubmit disabled={!input.trim()} />
                  </PromptInputFooter>
                </PromptInput>
              </div>
            </div>
          </ResizablePanel>

          {/* Resize handle + right panel — always mounted, collapsed when inactive */}
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

export default ThreadPage
