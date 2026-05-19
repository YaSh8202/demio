// ── Project Settings Dialog ──────────────────────────────────────────────────
//
// Edits a project's mutable fields: name and ElevenLabs voice. Model is
// edited from the per-thread input footer, so we keep this dialog focused on
// "things that travel with the project, not the run".

import { useEffect, useState } from "react"
import { Loader2, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { VoiceSelectorPopover } from "@/components/voice-selector-popover"
import type { VoiceSelection } from "@/components/voice-selector-popover"
import { apis } from "@/types/electron-api"

interface ProjectSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  initialName: string
  initialVoice: VoiceSelection
}

export function ProjectSettingsDialog({
  open,
  onOpenChange,
  projectId,
  initialName,
  initialVoice,
}: ProjectSettingsDialogProps) {
  const [name, setName] = useState(initialName)
  const [voice, setVoice] = useState<VoiceSelection>(initialVoice)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Reset form state every time the dialog opens — picks up any external
  // changes (e.g. auto-title rename) without leaking edits from the last
  // session.
  useEffect(() => {
    if (open) {
      setName(initialName)
      setVoice(initialVoice)
      setIsSubmitting(false)
    }
  }, [open, initialName, initialVoice])

  const handleSave = async () => {
    if (!apis) return
    const trimmed = name.trim()
    setIsSubmitting(true)
    try {
      const ops: Array<Promise<unknown>> = []
      if (trimmed && trimmed !== initialName) {
        ops.push(apis.store.updateProject(projectId, { name: trimmed }))
      }
      if (
        voice.voiceId !== initialVoice.voiceId ||
        voice.voiceName !== initialVoice.voiceName
      ) {
        ops.push(
          apis.store.updateProjectMeta(projectId, {
            voiceId: voice.voiceId,
            voiceName: voice.voiceName,
          })
        )
      }
      await Promise.all(ops)
      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <Settings className="text-primary" />
            </div>
            <div>
              <DialogTitle className="text-left">Project settings</DialogTitle>
              <DialogDescription className="text-left text-sm">
                Name and voiceover for this project
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled project"
              className="h-11"
            />
          </div>

          {/* Voice */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Voiceover</label>
            <div>
              <VoiceSelectorPopover
                value={voice}
                onChange={setVoice}
                placeholder="No voiceover"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Demos created in this project will be narrated with the selected
              voice. Pick "No voiceover" for silent demos.
            </p>
          </div>
        </div>

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className="h-11"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={isSubmitting}
            className="h-11"
          >
            {isSubmitting && (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            )}
            {isSubmitting ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
