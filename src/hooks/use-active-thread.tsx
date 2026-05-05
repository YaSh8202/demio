// ── Active Thread Provider ───────────────────────────────────────────────────
//
// Wraps ai-sdk's `useChat` with thread/project loading + persistence. Mirrors
// the chatbot repo's `useActiveChat` pattern: transport via
// DefaultChatTransport, messages/status owned by useChat, IPC plumbing hidden
// behind a custom fetch.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { generateId, DefaultChatTransport } from "ai"
import { useChat } from "@ai-sdk/react"
import { apis, events } from "@/types/electron-api"
import type {
  UIMessage,
  StoredThread,
  StoredProject,
  ProjectMeta,
} from "@electron/store/types"
import { createIpcChatFetch } from "@/lib/ipc-chat-transport"

// ── Types ────────────────────────────────────────────────────────────────────

export type ThreadStatus = "idle" | "submitted" | "streaming" | "error"

interface ActiveThreadContextValue {
  projectId: string
  threadId: string | null

  project: StoredProject | null
  thread: StoredThread | null
  threads: StoredThread[]
  messages: UIMessage[]
  status: ThreadStatus
  error: string | null

  selectedModel: string

  input: string
  setInput: (value: string) => void

  sendMessage: (text: string) => Promise<void>
  cancelRun: () => void
  createThread: (title?: string) => Promise<StoredThread>
  deleteThread: () => Promise<void>
  setSelectedModel: (fullModelId: string) => Promise<void>

  isLoaded: boolean
}

const ActiveThreadContext = createContext<ActiveThreadContextValue | null>(null)

interface ActiveThreadProviderProps {
  projectId: string
  threadId: string | null
  children: ReactNode
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function ActiveThreadProvider({
  projectId,
  threadId,
  children,
}: ActiveThreadProviderProps) {
  const navigate = useNavigate()

  const [project, setProject] = useState<StoredProject | null>(null)
  const [meta, setMeta] = useState<ProjectMeta | null>(null)
  const [thread, setThread] = useState<StoredThread | null>(null)
  const [threads, setThreads] = useState<StoredThread[]>([])
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState("")
  const [isLoaded, setIsLoaded] = useState(false)

  // Mutable refs so the transport (created once per thread) always reads
  // the latest values without re-instantiating.
  const threadIdRef = useRef<string | null>(threadId)
  useEffect(() => {
    threadIdRef.current = threadId
  }, [threadId])

  const selectedModelRef = useRef<string>(meta?.selectedModel ?? "")
  useEffect(() => {
    selectedModelRef.current = meta?.selectedModel ?? ""
  }, [meta])

  // Build the transport once per project. The refs are passed by reference
  // and only read later when ai-sdk invokes the fetch/prepare callbacks
  // (event-handler-like context), so the lint rule against ref-during-render
  // doesn't apply here.
  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      new DefaultChatTransport<UIMessage>({
        api: "ipc://agent",
        // eslint-disable-next-line react-hooks/refs
        fetch: createIpcChatFetch(projectId, threadIdRef),
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            message: messages.at(-1),
            modelId: selectedModelRef.current || undefined,
          },
        }),
        prepareReconnectToStreamRequest: ({ id }) => ({
          api: `ipc://agent/${id}/stream`,
        }),
      }),
    [projectId]
  )

  const {
    messages,
    setMessages,
    sendMessage: chatSendMessage,
    status: chatStatus,
    stop,
    error: chatError,
  } = useChat<UIMessage>({
    id: threadId ?? undefined,
    // Wait for persisted messages to load before resuming. Otherwise
    // resumeStream races with `setMessages(loaded)` from the load effect
    // and any in-flight assistant content streamed in via reconnect gets
    // wiped when we replay disk messages.
    resume: isLoaded,
    messages: initialMessages,
    generateId,
    transport,
    experimental_throttle: 50,
  })

  // ── Load data on mount / threadId change ───────────────────────────────
  useEffect(() => {
    if (!apis) return

    const storeApi = apis.store
    let cancelled = false

    const load = async () => {
      setIsLoaded(false)
      const [proj, threadList] = await Promise.all([
        storeApi.getProject(projectId),
        storeApi.listThreads(projectId),
      ])

      if (cancelled) return

      setProject(proj?.project ?? null)
      setMeta(proj?.meta ?? null)
      setThreads(threadList)

      if (threadId) {
        const [t, msgs] = await Promise.all([
          storeApi.getThread(projectId, threadId),
          storeApi.getMessages(projectId, threadId),
        ])

        if (cancelled) return

        setThread(t)
        const loaded = msgs as UIMessage[]
        setInitialMessages(loaded)
        setMessages(loaded)
      } else {
        setThread(null)
        setInitialMessages([])
        setMessages([])
      }

      setIsLoaded(true)
    }

    load()

    return () => {
      cancelled = true
    }
  }, [projectId, threadId, setMessages])

  // ── Subscribe to thread list changes ───────────────────────────────────
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

  // ── Multi-window sync for persisted messages ───────────────────────────
  useEffect(() => {
    if (!threadId) return

    const unsub = events?.store.onMessageAppended(
      (evtProjectId: string, evtThreadId: string, message: UIMessage) => {
        if (evtProjectId !== projectId || evtThreadId !== threadId) return
        setMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev
          return [...prev, message]
        })
      }
    )
    return () => unsub?.()
  }, [projectId, threadId, setMessages])

  // ── Actions ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || !apis) return

      let activeThreadId = threadId

      if (!activeThreadId) {
        const newThread = await apis.store.createThread(projectId)
        activeThreadId = newThread.id
        threadIdRef.current = activeThreadId

        await apis.store.updateProject(projectId, {
          lastThreadId: activeThreadId,
        })

        navigate(`/projects/${projectId}/threads/${activeThreadId}`, {
          replace: true,
        })
      }

      setInput("")
      await chatSendMessage({ text: trimmed })
    },
    [projectId, threadId, navigate, chatSendMessage]
  )

  const cancelRun = useCallback(() => {
    stop()
    if (apis && threadId) {
      apis.agent.cancel(projectId, threadId)
    }
  }, [projectId, threadId, stop])

  const createThread = useCallback(
    async (title?: string) => {
      if (!apis) throw new Error("APIs not available")
      const newThread = await apis.store.createThread(projectId, title)
      navigate(`/projects/${projectId}/threads/${newThread.id}`)
      return newThread
    },
    [projectId, navigate]
  )

  const setSelectedModel = useCallback(
    async (fullModelId: string) => {
      if (!apis) return
      await apis.store.updateProjectMeta(projectId, {
        selectedModel: fullModelId,
      })
      setMeta((prev) => (prev ? { ...prev, selectedModel: fullModelId } : prev))
    },
    [projectId]
  )

  const deleteThread = useCallback(async () => {
    if (!apis || !threadId) return
    await apis.store.deleteThread(projectId, threadId)
    const remaining = threads.filter((t) => t.id !== threadId)
    if (remaining.length > 0) {
      navigate(`/projects/${projectId}/threads/${remaining[0].id}`)
    } else {
      navigate("/")
    }
  }, [projectId, threadId, threads, navigate])

  // ── Derived status ─────────────────────────────────────────────────────

  const status: ThreadStatus =
    chatStatus === "submitted"
      ? "submitted"
      : chatStatus === "streaming"
        ? "streaming"
        : chatStatus === "error"
          ? "error"
          : "idle"

  // ── Context value ──────────────────────────────────────────────────────

  const value = useMemo<ActiveThreadContextValue>(
    () => ({
      projectId,
      threadId,
      project,
      thread,
      threads,
      messages: messages as UIMessage[],
      status,
      error: chatError?.message ?? null,
      selectedModel: meta?.selectedModel ?? "",
      input,
      setInput,
      sendMessage,
      cancelRun,
      createThread,
      deleteThread,
      setSelectedModel,
      isLoaded,
    }),
    [
      projectId,
      threadId,
      project,
      thread,
      threads,
      messages,
      status,
      chatError,
      meta,
      input,
      sendMessage,
      cancelRun,
      createThread,
      deleteThread,
      setSelectedModel,
      isLoaded,
    ]
  )

  return (
    <ActiveThreadContext.Provider value={value}>
      {children}
    </ActiveThreadContext.Provider>
  )
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useActiveThread() {
  const context = useContext(ActiveThreadContext)
  if (!context) {
    throw new Error(
      "useActiveThread must be used within an ActiveThreadProvider"
    )
  }
  return context
}
