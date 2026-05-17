import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface RenameThreadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentTitle: string
  onSubmit: (newTitle: string) => void | Promise<void>
}

export function RenameThreadDialog({
  open,
  onOpenChange,
  currentTitle,
  onSubmit,
}: RenameThreadDialogProps) {
  const [value, setValue] = useState(currentTitle)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setValue(currentTitle)
      setIsSubmitting(false)
    }
  }, [open, currentTitle])

  const trimmed = value.trim()
  const canSave =
    trimmed.length > 0 && trimmed !== currentTitle.trim() && !isSubmitting

  const handleSave = async () => {
    if (!canSave) return
    setIsSubmitting(true)
    try {
      await onSubmit(trimmed)
      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSave()
          }}
          className="flex flex-col gap-4"
        >
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Thread title"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {isSubmitting && (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              )}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
