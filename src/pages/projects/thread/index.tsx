import { useState, useEffect, useCallback } from "react"
import { useParams, Link } from "react-router-dom"
import { generateId } from "ai"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { apis, events } from "@/types/electron-api"
import type {
  UIMessage,
  StoredThread,
  MessageMetadata,
} from "../../../../electron/store/types"

// ── Helper ───────────────────────────────────────────────────────────────────

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
      <div className="flex h-svh items-center justify-center bg-neutral-950">
        <p className="text-white/50">Invalid project or thread.</p>
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
  const [thread, setThread] = useState<StoredThread | null>(null)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState("")
  const [loaded, setLoaded] = useState(false)

  // Load thread + messages on mount
  useEffect(() => {
    if (!apis) return

    let cancelled = false

    Promise.all([
      apis.store.getThread(projectId, threadId),
      apis.store.getMessages(projectId, threadId),
    ]).then(([t, msgs]) => {
      if (cancelled) return
      setThread(t)
      setMessages(msgs as UIMessage[])
      setLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [projectId, threadId])

  // Subscribe to new messages (multi-window sync)
  useEffect(() => {
    const unsub = events?.store.onMessageAppended(
      (evtProjectId: string, evtThreadId: string, message: UIMessage) => {
        if (evtProjectId === projectId && evtThreadId === threadId) {
          setMessages((prev) => {
            // Avoid duplicates (we also optimistically add)
            if (prev.some((m) => m.id === message.id)) return prev
            return [...prev, message]
          })
        }
      }
    )
    return () => unsub?.()
  }, [projectId, threadId])

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

  return (
    <div className="flex h-svh flex-col bg-neutral-950">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          asChild
          className="text-white/60 hover:text-white"
        >
          <Link to="/">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-white">
            {thread?.title ?? "Loading..."}
          </h2>
        </div>
      </header>

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
                    <MessageResponse>{getMessageText(msg)}</MessageResponse>
                  ) : (
                    <p className="whitespace-pre-wrap">{getMessageText(msg)}</p>
                  )}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input */}
      <div className="shrink-0 border-t border-white/10 p-4">
        <PromptInput
          onSubmit={handleSubmit}
          className="mx-auto w-full max-w-3xl"
        >
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              placeholder="Type a message..."
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit disabled={!input.trim()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

export default ThreadPage
