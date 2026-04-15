// ── Project Page (New Thread) ─────────────────────────────────────────────────
//
// Route: /projects/:projectId
//
// Empty-thread page. When the user sends their first message, the provider
// auto-creates a thread and navigates to the thread URL. Mirrors the chatbot's
// home page (page.tsx returns null, shell handles everything via ActiveChatProvider).

import { useParams } from "react-router-dom"
import { ActiveThreadProvider } from "@/hooks/use-active-thread"
import { ThreadShell } from "@/components/thread/thread-shell"

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()

  if (!projectId) {
    return (
      <div className="flex h-svh items-center justify-center">
        <p className="text-muted-foreground">Invalid project.</p>
      </div>
    )
  }

  return (
    <ActiveThreadProvider
      key={`${projectId}:new`}
      projectId={projectId}
      threadId={null}
    >
      <ThreadShell />
    </ActiveThreadProvider>
  )
}

export default ProjectPage
