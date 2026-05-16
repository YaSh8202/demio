import { useState, useEffect, useCallback, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { Globe, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ProjectSidebar } from "@/components/dashboard/project-sidebar"
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputSubmit,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { ModelSelectorPopover } from "@/components/model-selector"
import { useModelStore } from "@/store/model-store"
import type { StoredProject } from "../../electron/store/types"
import { apis, events, appInfo } from "@/types/electron-api"
import { SUGGESTIONS } from "@/lib/constants/suggestions"

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
}

// ── DashboardPage ────────────────────────────────────────────────────────────

export function DashboardPage() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<StoredProject[]>([])
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [domain, setDomain] = useState("")
  const selectedModel = useModelStore((s) => s.selectedModel)

  useEffect(() => {
    apis?.store.listProjects().then(setProjects)
  }, [])

  useEffect(() => {
    const unsub = events?.store.onProjectsChanged(
      (updatedProjects: StoredProject[]) => {
        setProjects(updatedProjects)
      }
    )
    return () => unsub?.()
  }, [])

  const cleanDomain = useMemo(() => normalizeDomain(domain), [domain])

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const text = message.text.trim()
      if (!text || !apis) return

      const { project, thread } = await apis.store.createProject(
        "Untitled project",
        selectedModel,
        cleanDomain ? { domain: cleanDomain } : undefined
      )

      void apis.store.autoTitleFromPrompt(
        project.id,
        thread.id,
        text,
        selectedModel
      )

      setPrompt("")
      setDomain("")
      navigate(`/projects/${project.id}/threads/${thread.id}`, {
        state: { pendingPrompt: text },
      })
    },
    [selectedModel, cleanDomain, navigate]
  )

  const handleSelect = useCallback(
    async (projectId: string) => {
      setSelectedId(projectId)
      if (!apis) return

      const result = await apis.store.getProject(projectId)
      if (!result) return

      const { project } = result

      if (project.lastThreadId) {
        navigate(`/projects/${projectId}/threads/${project.lastThreadId}`)
      } else {
        const thread = await apis.store.createThread(projectId)
        await apis.store.updateProject(projectId, { lastThreadId: thread.id })
        navigate(`/projects/${projectId}/threads/${thread.id}`)
      }
    },
    [navigate]
  )

  const handleSuggestionClick = (suggestion: string) => {
    setPrompt(suggestion)
  }

  const isMac = appInfo?.platform === "darwin"

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      {/* Top toolbar (drag region) */}
      <header
        className={cn(
          "drag-region flex h-11 shrink-0 items-center justify-between border-b border-white/[0.04] px-5",
          isMac && "traffic-light-pad"
        )}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative size-[18px] overflow-hidden rounded-[4px] bg-[var(--accent-brand)]">
              <span className="absolute top-1 left-1 size-2.5 rounded-[1px] border-t border-l border-background" />
            </span>
            <span className="text-sm font-semibold tracking-tight">Demio</span>
          </div>
          <span className="font-mono text-[10.5px] tracking-[0.14em] text-white/40 uppercase">
            <span className="text-[var(--accent-brand)]">●</span>
            &nbsp;&nbsp;Home / New project
          </span>
        </div>
        <div className="no-drag flex items-center gap-4">
          <span className="font-mono text-[10.5px] text-white/40">
            v2.4 · {selectedModel.split("/").pop() ?? "sonnet"}
          </span>
          <button
            type="button"
            className="flex items-center gap-1 text-[11.5px] text-white/55 hover:text-white"
          >
            Help <ChevronDown className="size-2.5" />
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="no-drag flex min-h-0 flex-1">
        <ProjectSidebar
          projects={projects}
          search={search}
          onSearchChange={setSearch}
          selectedId={selectedId}
          onSelect={handleSelect}
        />

        <main className="relative flex flex-1 flex-col items-center justify-center overflow-y-auto px-12 py-10">
          {/* Hero */}
          <div className="mb-7 w-full max-w-[720px] text-center">
            <h1 className="text-[72px] leading-[0.95] font-medium tracking-[-0.035em] text-white">
              Tell us what to <br />
              <span className="font-serif text-[var(--accent-brand)] italic">
                demo
              </span>
              <span className="text-[var(--accent-brand)]">.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-[480px] text-[14.5px] leading-relaxed text-white/55">
              Drop a URL. Describe what to showcase. Demio's agents will browse,
              script, record, and render the demo — while you direct from chat.
            </p>
          </div>

          {/* Composer */}
          <div className="w-full max-w-[720px]">
            <PromptInput onSubmit={handleSubmit} className="overflow-hidden">
              {/* Domain row */}
              <div className="flex items-center gap-2.5 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
                <Globe className="size-3.5 shrink-0 text-white/55" />
                <span className="font-mono text-[11.5px] text-white/50">
                  https://
                </span>
                <input
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.currentTarget.value)}
                  placeholder="workik.com"
                  className="flex-1 border-none bg-transparent font-mono text-[12px] text-white outline-none placeholder:text-white/25"
                />
                {cleanDomain && (
                  <span className="flex items-center gap-2">
                    <img
                      src={`https://www.google.com/s2/favicons?sz=64&domain=${cleanDomain}`}
                      alt=""
                      width={14}
                      height={14}
                      className="rounded-[2px]"
                      onError={(e) => {
                        e.currentTarget.style.display = "none"
                      }}
                    />
                    <span className="pulse-dot size-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span className="font-mono text-[10px] text-white/45">
                      ready
                    </span>
                  </span>
                )}
              </div>

              <PromptInputBody>
                <PromptInputTextarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.currentTarget.value)}
                  placeholder="Describe the demo you want to create…"
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger tooltip="Add attachments" />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments />
                      <PromptInputActionAddScreenshot />
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                  <ModelSelectorPopover />
                </PromptInputTools>
                <PromptInputSubmit disabled={!prompt.trim()} />
              </PromptInputFooter>
            </PromptInput>

            {/* Presets */}
            <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 self-center font-mono text-[10px] tracking-[0.14em] text-white/35 uppercase">
                or try
              </span>
              {SUGGESTIONS.map((s) => (
                <Button
                  key={s}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleSuggestionClick(s)}
                  className="h-auto rounded-full border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[11.5px] font-normal text-white/70 hover:bg-white/[0.04] hover:text-white"
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

export default DashboardPage
