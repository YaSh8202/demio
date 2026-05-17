// ── Model Selector ──────────────────────────────────────────────────────────
//
// Popover-based model selector with provider sidebar, search, and capabilities.
// Shared component used in both thread shell and dashboard.
// Fetches models from models.dev, filters to providers with valid API keys.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Bot, Brain, ChevronDown, Eye, Plus, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector"
import { AddLLMKeyDialog } from "@/components/add-llm-key-dialog"
import { useModels } from "@/hooks/use-models"
import { useProviderKeys } from "@/hooks/use-provider-keys"
import { useModelStore, useSelectedModelInfo } from "@/store/model-store"
import { LLMProvider } from "@/types/models"
import type { ModelWithProvider } from "@/types/models"
import { cn } from "@/lib/utils"

// ── Sub-components ──────────────────────────────────────────────────────────

function ModelCapabilities({ model }: { model: ModelWithProvider }) {
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-muted-foreground/8 p-0.5">
      {model.attachment && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex size-5 items-center justify-center text-emerald-500">
              <Eye className="size-3.5" />
            </div>
          </TooltipTrigger>
          <TooltipContent>Vision</TooltipContent>
        </Tooltip>
      )}
      {model.reasoning && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex size-5 items-center justify-center text-violet-500">
              <Brain className="size-3.5" />
            </div>
          </TooltipTrigger>
          <TooltipContent>Reasoning</TooltipContent>
        </Tooltip>
      )}
      {model.tool_call && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex size-5 items-center justify-center text-indigo-500">
              <Wrench className="size-3.5" />
            </div>
          </TooltipTrigger>
          <TooltipContent>Tool Calling</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

const transition = {
  type: "tween" as const,
  ease: "easeOut" as const,
  duration: 0.15,
}

function ProviderSidebar({
  providers,
  activeProvider,
  onProviderSelect,
  onAddKey,
  canAddMoreKeys,
}: {
  providers: { id: LLMProvider; name: string }[]
  activeProvider: LLMProvider | null
  onProviderSelect: (provider: LLMProvider) => void
  onAddKey: () => void
  canAddMoreKeys: boolean
}) {
  const [buttonRefs, setButtonRefs] = useState<Array<HTMLButtonElement | null>>(
    []
  )
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const navRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setButtonRefs((prev) => prev.slice(0, providers.length))
  }, [providers.length])

  // Read DOM rects synchronously during render so the active/hover
  // overlays animate to the correct position on the same paint as the
  // buttons themselves. The eslint rule warns about refs-during-render
  // generally, but for layout-driven animations this is the established
  // framer-motion pattern.
  // eslint-disable-next-line react-hooks/refs
  const navRect = navRef.current?.getBoundingClientRect()
  const activeIndex = providers.findIndex((p) => p.id === activeProvider)
  const activeRect = buttonRefs[activeIndex]?.getBoundingClientRect()
  const hoveredRect = buttonRefs[hoveredIndex ?? -1]?.getBoundingClientRect()

  return (
    <div className="flex w-[52px] flex-col border-r bg-muted/30">
      <div className="flex-1 overflow-y-auto">
        <nav
          ref={navRef}
          className="relative flex flex-col items-center gap-1.5 p-2"
          onPointerLeave={() => setHoveredIndex(null)}
        >
          {providers.map((provider, i) => (
            <Tooltip key={provider.id}>
              <TooltipTrigger asChild>
                <button
                  ref={(el) => {
                    buttonRefs[i] = el
                  }}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onProviderSelect(provider.id)
                  }}
                  onPointerEnter={() => setHoveredIndex(i)}
                  onFocus={() => setHoveredIndex(i)}
                  className={cn(
                    "relative z-20 flex size-9 cursor-pointer items-center justify-center rounded-md transition-colors",
                    activeProvider === provider.id
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <ModelSelectorLogo
                    provider={provider.id}
                    className="size-5"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{provider.name}</TooltipContent>
            </Tooltip>
          ))}

          {/* Hover effect */}
          <AnimatePresence>
            {hoveredRect && navRect && hoveredIndex !== activeIndex && (
              <motion.div
                key="hover"
                className="absolute top-0 left-0 z-10 rounded-md bg-muted"
                initial={{ opacity: 0 }}
                animate={{
                  opacity: 1,
                  width: hoveredRect.width,
                  height: hoveredRect.height,
                  x: hoveredRect.left - navRect.left,
                  y: hoveredRect.top - navRect.top,
                }}
                exit={{ opacity: 0 }}
                transition={transition}
              />
            )}
          </AnimatePresence>

          {/* Active indicator */}
          <AnimatePresence>
            {activeRect && navRect && (
              <motion.div
                className="absolute top-0 left-0 z-10 rounded-md bg-primary/10 ring-1 ring-primary/20"
                initial={false}
                animate={{
                  width: activeRect.width,
                  height: activeRect.height,
                  x: activeRect.left - navRect.left,
                  y: activeRect.top - navRect.top,
                  opacity: 1,
                }}
                transition={transition}
              />
            )}
          </AnimatePresence>
        </nav>
      </div>
      {canAddMoreKeys && (
        <div className="flex justify-center border-t p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onAddKey()
                }}
                className="flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Add API key</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

interface ModelSelectorPopoverProps {
  disabled?: boolean
}

export function ModelSelectorPopover({ disabled }: ModelSelectorPopoverProps) {
  const [open, setOpen] = useState(false)
  const [isAddKeyDialogOpen, setIsAddKeyDialogOpen] = useState(false)
  const [activeProviderTab, setActiveProviderTab] =
    useState<LLMProvider | null>(null)
  const [searchQuery, setSearchQuery] = useState("")

  const { setSelectedModel } = useModelStore()
  const { providers, allModels } = useModels()
  const { keys, addKey } = useProviderKeys()
  const selectedModelInfo = useSelectedModelInfo(allModels)

  const validKeys = keys.filter((key) => key.isValid)

  const availableProviders = useMemo(() => {
    if (!providers || validKeys.length === 0) return []
    const providersWithKeys = validKeys.map((k) => k.provider)
    return providers.filter((p) => providersWithKeys.includes(p.id))
  }, [providers, validKeys])

  const existingProviders = validKeys.map((k) => k.provider as LLMProvider)
  const canAddMoreKeys =
    existingProviders.length < Object.values(LLMProvider).length

  const isSearchMode = searchQuery.trim().length > 0

  const filteredModels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (query) {
      return availableProviders.flatMap((provider) =>
        provider.models.filter(
          (model) =>
            model.name.toLowerCase().includes(query) ||
            model.id.toLowerCase().includes(query)
        )
      )
    }
    const activeProvider = availableProviders.find(
      (p) => p.id === activeProviderTab
    )
    return activeProvider?.models ?? []
  }, [availableProviders, activeProviderTab, searchQuery])

  // Sync provider tab when popover opens. Derive from the open transition
  // edge — setState calls below are guarded so they only run on the open
  // edge, not on every effect re-run.
  const prevOpenRef = useRef(false)
  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (open && !wasOpen) {
      if (
        selectedModelInfo &&
        availableProviders.some((p) => p.id === selectedModelInfo.provider)
      ) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setActiveProviderTab(selectedModelInfo.provider)
      } else if (availableProviders.length > 0) {
        setActiveProviderTab(availableProviders[0].id)
      }
    }
    if (!open && wasOpen) setSearchQuery("")
  }, [open, selectedModelInfo, availableProviders])

  const handleModelSelect = useCallback(
    (model: ModelWithProvider) => {
      setSelectedModel(model.fullId, model.provider)
      setOpen(false)
    },
    [setSelectedModel]
  )

  const handleAddKey = useCallback(() => {
    setIsAddKeyDialogOpen(true)
    setOpen(false)
  }, [])

  // No keys state
  if (validKeys.length === 0) {
    return (
      <>
        <div className="flex items-center gap-2 rounded-lg border-destructive/50 bg-muted/50 px-3 py-2">
          <Bot className="text-destructive" />
          <span className="flex-1 text-sm text-destructive">
            No API keys configured
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAddKeyDialogOpen(true)}
          >
            <Plus data-icon="inline-start" />
            Add Key
          </Button>
        </div>
        <AddLLMKeyDialog
          open={isAddKeyDialogOpen}
          onOpenChange={setIsAddKeyDialogOpen}
          existingProviders={[]}
          onAddKey={addKey}
        />
      </>
    )
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-expanded={open}
            className="max-w-[300px] justify-between"
            disabled={disabled}
            size="sm"
          >
            <div className="flex items-center gap-2 truncate">
              {selectedModelInfo && (
                <ModelSelectorLogo
                  provider={selectedModelInfo.provider}
                  className="size-4"
                />
              )}
              <span className="truncate">
                {selectedModelInfo ? selectedModelInfo.name : "Select model"}
              </span>
            </div>
            <ChevronDown className="ml-2 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="h-[380px] w-[420px] gap-0 p-0" align="start">
          <Command shouldFilter={false} className="flex h-full flex-col">
            <CommandInput
              placeholder="Search models..."
              value={searchQuery}
              onValueChange={setSearchQuery}
              className="h-9"
            />
            <div className="flex min-h-0 flex-1">
              {!isSearchMode && (
                <ProviderSidebar
                  providers={availableProviders}
                  activeProvider={activeProviderTab}
                  onProviderSelect={setActiveProviderTab}
                  onAddKey={handleAddKey}
                  canAddMoreKeys={canAddMoreKeys}
                />
              )}
              <CommandList className="max-h-none flex-1 overflow-y-auto px-2 py-2">
                {filteredModels.length === 0 ? (
                  <CommandEmpty>
                    {searchQuery
                      ? "No models match your search"
                      : "No models available"}
                  </CommandEmpty>
                ) : (
                  filteredModels.map((model) => (
                    <CommandItem
                      key={model.fullId}
                      value={`${model.name} ${model.id} ${model.fullId}`}
                      onSelect={() => handleModelSelect(model)}
                      className={cn(
                        "px-3 py-2",
                        selectedModelInfo?.fullId === model.fullId &&
                          "bg-primary/10 text-primary"
                      )}
                    >
                      {isSearchMode && (
                        <div className="mr-2 shrink-0">
                          <ModelSelectorLogo
                            provider={model.provider}
                            className="size-4"
                          />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {model.name}
                          </span>
                          <ModelCapabilities model={model} />
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          {model.limit?.context && (
                            <span>
                              Context:{" "}
                              {new Intl.NumberFormat("en-US", {
                                notation: "compact",
                              }).format(model.limit.context)}
                            </span>
                          )}
                          {!!model.cost?.input && !!model.cost?.output && (
                            <>
                              <span>&middot;</span>
                              <span>
                                ${model.cost.input.toFixed(2)}/$
                                {model.cost.output.toFixed(2)} per 1M
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </CommandItem>
                  ))
                )}
              </CommandList>
            </div>
          </Command>
        </PopoverContent>
      </Popover>

      <AddLLMKeyDialog
        open={isAddKeyDialogOpen}
        onOpenChange={setIsAddKeyDialogOpen}
        existingProviders={existingProviders}
        onAddKey={addKey}
      />
    </>
  )
}
