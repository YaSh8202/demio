import { useState, useEffect, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { ProjectSidebar } from "@/components/dashboard/project-sidebar"
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion"
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
import {
  ModelSelector,
  ModelSelectorTrigger,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorList,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorLogo,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector"
import type { StoredProject } from "../../electron/store/types"
import { apis, events } from "@/types/electron-api"
import { MODELS, getModelName } from "@/lib/constants/models"
import { SUGGESTIONS } from "@/lib/constants/suggestions"

// ── DashboardPage ────────────────────────────────────────────────────────────

export function DashboardPage() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<StoredProject[]>([])
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newProjectName, setNewProjectName] = useState("")
  const [selectedModel, setSelectedModel] = useState(MODELS[0].models[0].id)
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)

  // Load projects from store on mount
  useEffect(() => {
    apis?.store.listProjects().then(setProjects)
  }, [])

  // Subscribe to project changes (multi-window sync)
  useEffect(() => {
    const unsub = events?.store.onProjectsChanged(
      (updatedProjects: StoredProject[]) => {
        setProjects(updatedProjects)
      }
    )
    return () => unsub?.()
  }, [])

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const name = message.text.trim()
      if (!name || !apis) return

      const { project, thread } = await apis.store.createProject(
        name,
        selectedModel
      )

      setNewProjectName("")
      navigate(`/projects/${project.id}/threads/${thread.id}`)
    },
    [selectedModel, navigate]
  )

  const handleSelect = useCallback(
    async (projectId: string) => {
      setSelectedId(projectId)

      if (!apis) return

      // Get the project to find its last active thread
      const result = await apis.store.getProject(projectId)
      if (!result) return

      const { project } = result

      if (project.lastThreadId) {
        navigate(`/projects/${projectId}/threads/${project.lastThreadId}`)
      } else {
        // No thread yet — create one and navigate
        const thread = await apis.store.createThread(projectId)
        await apis.store.updateProject(projectId, {
          lastThreadId: thread.id,
        })
        navigate(`/projects/${projectId}/threads/${thread.id}`)
      }
    },
    [navigate]
  )

  const handleSuggestionClick = (suggestion: string) => {
    setNewProjectName(suggestion)
  }

  const handleModelSelect = (modelId: string) => {
    setSelectedModel(modelId)
    setModelSelectorOpen(false)
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-neutral-950">
      {/* App header */}
      <header className="flex shrink-0 items-center px-5 pt-4 pb-3">
        <h2 className="text-lg font-bold tracking-tight text-white">Demio</h2>
      </header>

      {/* Content area */}
      <div className="flex min-h-0 flex-1 gap-0 px-4 pb-4">
        {/* Left sidebar card */}
        <ProjectSidebar
          projects={projects}
          search={search}
          onSearchChange={setSearch}
          selectedId={selectedId}
          onSelect={handleSelect}
        />

        {/* Right main area */}
        <main className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6">
          {/* Welcome heading */}
          <h1 className="text-center text-6xl font-bold tracking-tight text-white">
            Welcome to Demio.
          </h1>

          {/* Suggestion chips */}
          <Suggestions className="mx-auto">
            {SUGGESTIONS.map((s) => (
              <Suggestion
                key={s}
                suggestion={s}
                onClick={handleSuggestionClick}
              />
            ))}
          </Suggestions>

          {/* Create project input */}
          <PromptInput
            onSubmit={handleSubmit}
            className="w-full max-w-2xl"
            multiple
          >
            <PromptInputBody>
              <PromptInputTextarea
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.currentTarget.value)}
                placeholder="Describe the demo you want to create..."
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

                <ModelSelector
                  open={modelSelectorOpen}
                  onOpenChange={setModelSelectorOpen}
                >
                  <ModelSelectorTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {getModelName(selectedModel)}
                    </Button>
                  </ModelSelectorTrigger>
                  <ModelSelectorContent>
                    <ModelSelectorInput placeholder="Search models..." />
                    <ModelSelectorList>
                      <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                      {MODELS.map((group) => (
                        <ModelSelectorGroup
                          key={group.provider}
                          heading={group.provider}
                        >
                          {group.models.map((model) => (
                            <ModelSelectorItem
                              key={model.id}
                              value={model.id}
                              onSelect={() => handleModelSelect(model.id)}
                              className="flex items-center gap-2"
                            >
                              <ModelSelectorLogo provider={group.provider} />
                              <ModelSelectorName>
                                {model.name}
                              </ModelSelectorName>
                            </ModelSelectorItem>
                          ))}
                        </ModelSelectorGroup>
                      ))}
                    </ModelSelectorList>
                  </ModelSelectorContent>
                </ModelSelector>
              </PromptInputTools>
              <PromptInputSubmit disabled={!newProjectName.trim()} />
            </PromptInputFooter>
          </PromptInput>
        </main>
      </div>
    </div>
  )
}

export default DashboardPage
