// ── Suspension Card ──────────────────────────────────────────────────────────
//
// Renders the single active tool suspension surfaced by `useAgentEvents`
// (`ask_user` or `submit_plan`), replacing the prompt input while the run is
// parked waiting on the user. Resolves via `onRespond(resumeData)`, which the
// caller wires to `respond(suspension.toolCallId, resumeData)`.
//
// Payload/resume shapes (confirmed against the installed @mastra/core build —
// see task-6-report.md for the exact file/line citations):
//   - ask_user   → suspend payload `{question, options?, selectionMode?}`
//                  (`node_modules/@mastra/core/dist/tools/builtin/ask-user.d.ts`).
//                  Resume data is a bare string (free text / single-select) or
//                  `string[]` (multi-select). NOTE: the installed
//                  `AskUserSuspendPayload` has NO `secret` field — unlike the
//                  brief's MastraCode citation. `secret` is read defensively
//                  below in case a future tool version adds it; today it is
//                  always `undefined` and the field renders as plain text.
//   - submit_plan → suspend payload `{path, title?, plan?}`
//                  (`.../tools/builtin/submit-plan.d.ts`), plus a `planContent`
//                  sibling field `electron/handlers/agent.ts`
//                  (`attachPlanContent`) adds by reading the plan file off
//                  disk. Resume data is `{action: "approved" | "rejected",
//                  feedback?}` (`SubmitPlanResumeData`).

import { useState } from "react"
import { CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MessageResponse } from "@/components/ai-elements/message"
import { cn } from "@/lib/utils"

interface AskUserOption {
  label: string
  description?: string
}

interface AskUserPayload {
  question?: string
  options?: AskUserOption[]
  selectionMode?: "single_select" | "multi_select"
  /** Not part of the installed ask_user suspend payload — see file header. */
  secret?: boolean
}

interface SubmitPlanPayload {
  path?: string
  title?: string
  plan?: string
  /** Attached by `attachPlanContent` in electron/handlers/agent.ts. */
  planContent?: string
}

interface SuspensionCardProps {
  toolName: string
  payload: unknown
  onRespond: (resumeData: unknown) => void
}

export function SuspensionCard({
  toolName,
  payload,
  onRespond,
}: SuspensionCardProps) {
  if (toolName === "submit_plan") {
    return (
      <SubmitPlanCard
        payload={(payload as SubmitPlanPayload) ?? {}}
        onRespond={onRespond}
      />
    )
  }

  return (
    <AskUserCard
      payload={(payload as AskUserPayload) ?? {}}
      onRespond={onRespond}
    />
  )
}

// ── submit_plan ──────────────────────────────────────────────────────────────

function SubmitPlanCard({
  payload,
  onRespond,
}: {
  payload: SubmitPlanPayload
  onRespond: (resumeData: unknown) => void
}) {
  const [requestingChanges, setRequestingChanges] = useState(false)
  const [feedback, setFeedback] = useState("")
  const plan = payload.planContent ?? payload.plan ?? ""

  return (
    <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-surface p-4 text-surface-foreground shadow-sm">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
        Plan review
      </p>
      {payload.title && (
        <p className="mt-1 text-sm font-medium text-foreground">
          {payload.title}
        </p>
      )}

      <div className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/30 p-3">
        {plan ? (
          <MessageResponse>{plan}</MessageResponse>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            Plan content unavailable — the file may have been unreadable.
          </p>
        )}
      </div>

      {requestingChanges ? (
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            autoFocus
            placeholder="What should change?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRequestingChanges(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() =>
                onRespond({
                  action: "rejected",
                  feedback: feedback.trim() || undefined,
                })
              }
            >
              Send feedback
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRequestingChanges(true)}
          >
            Request changes
          </Button>
          <Button size="sm" onClick={() => onRespond({ action: "approved" })}>
            Approve plan
          </Button>
        </div>
      )}
    </div>
  )
}

// ── ask_user ─────────────────────────────────────────────────────────────────

function AskUserCard({
  payload,
  onRespond,
}: {
  payload: AskUserPayload
  onRespond: (resumeData: unknown) => void
}) {
  const question = payload.question ?? ""
  const options = payload.options ?? []
  const isMulti = payload.selectionMode === "multi_select"
  const isSecret = Boolean(payload.secret)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [freeText, setFreeText] = useState("")

  const toggleOption = (label: string) => {
    if (!isMulti) {
      onRespond(label)
      return
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const submitFreeText = () => {
    const trimmed = freeText.trim()
    if (!trimmed) return
    onRespond(trimmed)
  }

  const submitMulti = () => {
    if (selected.size === 0) return
    onRespond(Array.from(selected))
  }

  return (
    <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-surface p-4 text-surface-foreground shadow-sm">
      <p className="text-sm leading-5 font-medium text-foreground">
        {question}
      </p>
      {isMulti && (
        <p className="mt-0.5 text-[11px] tracking-wide text-muted-foreground uppercase">
          multi-select
        </p>
      )}

      {options.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {options.map((option) => {
            const checked = selected.has(option.label)
            return (
              <button
                key={option.label}
                type="button"
                onClick={() => toggleOption(option.label)}
                className={cn(
                  "flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2 text-left transition-colors hover:bg-muted/40",
                  checked && "border-primary bg-primary/5"
                )}
              >
                {isMulti && (
                  <span
                    className={cn(
                      "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
                      checked &&
                        "border-primary bg-primary text-primary-foreground"
                    )}
                    aria-hidden
                  >
                    {checked && <CheckIcon className="size-3" />}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-5 font-medium text-foreground">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
          {isMulti && (
            <Button
              size="sm"
              className="mt-1 self-end"
              disabled={selected.size === 0}
              onClick={submitMulti}
            >
              Submit selection
            </Button>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Input
          type={isSecret ? "password" : "text"}
          placeholder={
            options.length > 0
              ? isSecret
                ? "Or enter a secret value..."
                : "Or type your own answer..."
              : isSecret
                ? "Enter the secret value..."
                : "Type your answer..."
          }
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              submitFreeText()
            }
          }}
          autoComplete="off"
        />
        <Button size="sm" onClick={submitFreeText} disabled={!freeText.trim()}>
          Send
        </Button>
      </div>

      <button
        type="button"
        onClick={() => onRespond("(skipped)")}
        className="mt-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        Skip question
      </button>
    </div>
  )
}
