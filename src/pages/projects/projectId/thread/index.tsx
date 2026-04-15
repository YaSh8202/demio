// ── Thread Page ──────────────────────────────────────────────────────────────
//
// Route: /projects/:projectId/threads/:threadId
//
// Wraps ActiveThreadProvider + ThreadShell. Key-based remount ensures clean
// state when navigating between threads (mirrors chatbot's page → shell pattern).

import { useParams } from "react-router-dom"
import { ActiveThreadProvider } from "@/hooks/use-active-thread"
import { ThreadShell } from "@/components/thread/thread-shell"

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
    <ActiveThreadProvider
      key={`${projectId}:${threadId}`}
      projectId={projectId}
      threadId={threadId}
    >
      <ThreadShell />
    </ActiveThreadProvider>
  )
}

export default ThreadPage
