// ── Project Page ─────────────────────────────────────────────────────────────
//
// Route: /projects/:projectId
//
// Resolves the user's last-opened thread (or most recent thread) and redirects
// to /projects/:projectId/threads/:targetId. If the project has no threads,
// renders ThreadShell with threadId=null so the user can create a new one.

import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ActiveThreadProvider } from "@/hooks/use-active-thread"
import { ThreadShell } from "@/components/thread/thread-shell"
import { apis } from "@/types/electron-api"

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    if (!projectId || !apis) return
    const storeApi = apis.store
    let cancelled = false

    const resolve = async () => {
      const [proj, threads] = await Promise.all([
        storeApi.getProject(projectId),
        storeApi.listThreads(projectId),
      ])
      if (cancelled) return

      const lastId = proj?.project.lastThreadId ?? null
      const target =
        (lastId && threads.find((t) => t.id === lastId)?.id) ??
        threads[0]?.id ??
        null

      if (target) {
        navigate(`/projects/${projectId}/threads/${target}`, { replace: true })
      } else {
        setResolved(true)
      }
    }

    void resolve()
    return () => {
      cancelled = true
    }
  }, [projectId, navigate])

  if (!projectId) {
    return (
      <div className="flex h-svh items-center justify-center">
        <p className="text-muted-foreground">Invalid project.</p>
      </div>
    )
  }

  if (!resolved) return null

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
