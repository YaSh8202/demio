// ── Voice Selector Popover ──────────────────────────────────────────────────
//
// Controlled voice picker. Mirrors ModelSelectorPopover but for ElevenLabs
// voices. The first row is always "No voiceover" (clears the selection).
// If no ElevenLabs key is configured, the popover renders an "Add ElevenLabs
// API key" CTA that opens AddLLMKeyDialog pre-selected to elevenlabs.

import { useEffect, useMemo, useRef, useState } from "react"
import { AudioLines, ChevronDown, Key, Pause, Play, X } from "lucide-react"
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
import { AddLLMKeyDialog } from "@/components/add-llm-key-dialog"
import { useVoices } from "@/hooks/use-voices"
import type { DemioVoice } from "@/hooks/use-voices"
import { useProviderKeys } from "@/hooks/use-provider-keys"
import { LLMProvider } from "@/types/models"
import { cn } from "@/lib/utils"

export interface VoiceSelection {
  voiceId: string | null
  voiceName: string | null
}

interface VoiceSelectorPopoverProps {
  value: VoiceSelection
  onChange: (value: VoiceSelection) => void
  disabled?: boolean
  /** Compact trigger label when nothing is selected. */
  placeholder?: string
}

function VoiceLabels({ voice }: { voice: DemioVoice }) {
  const bits: string[] = []
  if (voice.labels.gender) bits.push(voice.labels.gender)
  if (voice.labels.age) bits.push(voice.labels.age)
  if (voice.labels.accent) bits.push(voice.labels.accent)
  if (bits.length === 0) return null
  return (
    <span className="text-xs text-muted-foreground">{bits.join(" · ")}</span>
  )
}

function PreviewButton({ url }: { url: string | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  if (!url) return null

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!audioRef.current) {
          audioRef.current = new Audio(url)
          audioRef.current.addEventListener("ended", () => setPlaying(false))
          audioRef.current.addEventListener("pause", () => setPlaying(false))
        }
        if (playing) {
          audioRef.current.pause()
          setPlaying(false)
        } else {
          void audioRef.current.play()
          setPlaying(true)
        }
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      title={playing ? "Pause preview" : "Play preview"}
    >
      {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
    </button>
  )
}

export function VoiceSelectorPopover({
  value,
  onChange,
  disabled,
  placeholder = "Voice",
}: VoiceSelectorPopoverProps) {
  const [open, setOpen] = useState(false)
  const [isAddKeyDialogOpen, setIsAddKeyDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  const { voices, hasKey, isLoading } = useVoices()
  const { keys, addKey } = useProviderKeys()

  // Pass the full configured-provider set so the dialog filters out anything
  // already added — ElevenLabs will be selectable iff its key is missing.
  const existingProviders = useMemo(
    () =>
      keys
        .filter((k) => k.isValid)
        .map((k) => k.provider as LLMProvider),
    [keys]
  )

  const filteredVoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return voices
    return voices.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.labels.accent?.toLowerCase().includes(q) ||
        v.labels.descriptive?.toLowerCase().includes(q)
    )
  }, [voices, searchQuery])

  const handleOpenChange = (next: boolean) => {
    if (!next) setSearchQuery("")
    setOpen(next)
  }

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange} modal>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-expanded={open}
            className="max-w-[220px] justify-between"
            disabled={disabled}
            size="sm"
          >
            <div className="flex items-center gap-2 truncate">
              <AudioLines className="size-4" />
              <span className="truncate">{value.voiceName ?? placeholder}</span>
            </div>
            <ChevronDown className="ml-2 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="h-[380px] w-[360px] gap-0 p-0" align="start">
          {!hasKey ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                <Key className="text-primary" />
              </div>
              <div>
                <p className="font-medium">Add an ElevenLabs API key</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Required to fetch voices and synthesize voiceover for your
                  demos.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false)
                  setIsAddKeyDialogOpen(true)
                }}
              >
                Add ElevenLabs key
              </Button>
            </div>
          ) : (
            <Command shouldFilter={false} className="flex h-full flex-col">
              <CommandInput
                placeholder="Search voices..."
                value={searchQuery}
                onValueChange={setSearchQuery}
                className="h-9"
              />
              <CommandList className="max-h-none flex-1 overflow-y-auto px-2 py-2">
                {/* "No voiceover" — always available */}
                <CommandItem
                  value="__no_voiceover__"
                  onSelect={() => {
                    onChange({ voiceId: null, voiceName: null })
                    setOpen(false)
                  }}
                  className={cn(
                    "px-3 py-2",
                    value.voiceId === null && "bg-primary/10 text-primary"
                  )}
                >
                  <X className="mr-2 size-4 text-muted-foreground" />
                  <span className="flex-1 text-sm">No voiceover</span>
                </CommandItem>

                {isLoading && (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    Loading voices…
                  </p>
                )}

                {!isLoading && filteredVoices.length === 0 && (
                  <CommandEmpty>
                    {searchQuery
                      ? "No voices match your search"
                      : "No voices available on your account"}
                  </CommandEmpty>
                )}

                {filteredVoices.map((voice) => (
                  <CommandItem
                    key={voice.voiceId}
                    value={`${voice.name} ${voice.labels.accent ?? ""} ${voice.labels.descriptive ?? ""}`}
                    onSelect={() => {
                      onChange({
                        voiceId: voice.voiceId,
                        voiceName: voice.name,
                      })
                      setOpen(false)
                    }}
                    className={cn(
                      "px-3 py-2",
                      value.voiceId === voice.voiceId &&
                        "bg-primary/10 text-primary"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {voice.name}
                      </div>
                      <VoiceLabels voice={voice} />
                    </div>
                    <PreviewButton url={voice.previewUrl} />
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          )}
        </PopoverContent>
      </Popover>

      <AddLLMKeyDialog
        open={isAddKeyDialogOpen}
        onOpenChange={setIsAddKeyDialogOpen}
        existingProviders={existingProviders}
        initialProvider={LLMProvider.ELEVENLABS}
        onAddKey={addKey}
      />
    </>
  )
}
