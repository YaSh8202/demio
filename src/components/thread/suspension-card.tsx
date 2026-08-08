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
//   - generate_demo → (Task 13) the `demo-video` workflow's own per-scene
//                  suspend/resume, surfaced as a NATIVE tool suspension —
//                  see `electron/agent/controller.ts`'s `generateDemoTool`
//                  file header for the full reconciliation. Suspend payload
//                  `{runId, sceneId, failure, attempts}` (the tool's own
//                  `suspendSchema`). Resume data is `{action: "retry" |
//                  "skip" | "abort", guidance?, runId}` — `runId` is echoed
//                  straight back from the suspend payload so a resume
//                  survives an app restart (`resumeSchema`'s own comment:
//                  the in-memory `activeDemoRuns` map is only a fallback).

import { useState } from "react"
import { CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SECRET_QUESTION_RE } from "@/components/thread/tool-usage"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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

/** `generateDemoTool`'s `suspendSchema` (electron/agent/controller.ts). */
interface GenerateDemoPayload {
  runId?: string
  sceneId?: string
  failure?: string
  attempts?: number
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
  // In-flight guard: `onRespond` triggers an IPC round-trip
  // (`respondSuspension`) that only resolves once the main process's
  // `respondToToolSuspension`/`handlePlanApprovalResume` call settles —
  // there is no optimistic local removal of the suspension in between (it
  // stays rendered until the next `display_state_changed`/
  // `tool_suspension_cancelled` event clears it). Without this, a second
  // click before that round-trip lands calls `respondSuspension` again for
  // an already-resolved `toolCallId`, which the main handler surfaces as a
  // spurious `error` broadcast (`electron/handlers/agent.ts`'s
  // `broadcastError` on the `.catch()` of the second, now-invalid call).
  // `responded` freezes every control after the first click; it's local
  // state keyed by the card's own `key={toolCallId}` remount (thread-shell.tsx),
  // so a genuinely new suspension always starts unguarded.
  const [responded, setResponded] = useState(false)
  const guardedRespond = (resumeData: unknown) => {
    if (responded) return
    setResponded(true)
    onRespond(resumeData)
  }

  if (toolName === "submit_plan") {
    return (
      <SubmitPlanCard
        payload={(payload as SubmitPlanPayload) ?? {}}
        onRespond={guardedRespond}
        disabled={responded}
      />
    )
  }

  if (toolName === "generate_demo") {
    return (
      <GenerateDemoCard
        payload={(payload as GenerateDemoPayload) ?? {}}
        onRespond={guardedRespond}
        disabled={responded}
      />
    )
  }

  return (
    <AskUserCard
      payload={(payload as AskUserPayload) ?? {}}
      onRespond={guardedRespond}
      disabled={responded}
    />
  )
}

// ── submit_plan ──────────────────────────────────────────────────────────────

function SubmitPlanCard({
  payload,
  onRespond,
  disabled,
}: {
  payload: SubmitPlanPayload
  onRespond: (resumeData: unknown) => void
  disabled: boolean
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
            disabled={disabled}
            placeholder="What should change?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setRequestingChanges(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={disabled}
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
            disabled={disabled}
            onClick={() => setRequestingChanges(true)}
          >
            Request changes
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => onRespond({ action: "approved" })}
          >
            Approve plan
          </Button>
        </div>
      )}
    </div>
  )
}

// ── generate_demo ────────────────────────────────────────────────────────────

function GenerateDemoCard({
  payload,
  onRespond,
  disabled,
}: {
  payload: GenerateDemoPayload
  onRespond: (resumeData: unknown) => void
  disabled: boolean
}) {
  const [requestingGuidance, setRequestingGuidance] = useState(false)
  const [guidance, setGuidance] = useState("")
  const { runId, sceneId, failure, attempts } = payload

  const respondWithAction = (action: "retry" | "skip" | "abort") => {
    onRespond({
      action,
      guidance:
        action === "retry" ? guidance.trim() || undefined : undefined,
      runId,
    })
  }

  return (
    <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-surface p-4 text-surface-foreground shadow-sm">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
        Scene recording stalled
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <p className="text-sm font-medium text-foreground">
          {sceneId ?? "Unknown scene"}
        </p>
        {typeof attempts === "number" && (
          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
            {attempts} attempt{attempts === 1 ? "" : "s"}
          </Badge>
        )}
      </div>

      {failure && (
        <div className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/30 p-3">
          <p className="text-[12px] leading-5 break-words text-muted-foreground">
            {failure}
          </p>
        </div>
      )}

      {requestingGuidance ? (
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            autoFocus
            disabled={disabled}
            placeholder="Tell the recorder what to do differently on the retry (optional)..."
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setRequestingGuidance(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => respondWithAction("retry")}
            >
              Retry scene
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="destructive"
            disabled={disabled}
            onClick={() => respondWithAction("abort")}
          >
            Abort run
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => respondWithAction("skip")}
          >
            Skip scene
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setRequestingGuidance(true)}
          >
            Retry with guidance
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => respondWithAction("retry")}
          >
            Retry scene
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
  disabled,
}: {
  payload: AskUserPayload
  onRespond: (resumeData: unknown) => void
  disabled: boolean
}) {
  const question = payload.question ?? ""
  const options = payload.options ?? []
  const isMulti = payload.selectionMode === "multi_select"
  // The built-in's suspend payload has no `secret` flag — fall back to the
  // shared question-text heuristic so credential prompts get a masked
  // input (see SECRET_QUESTION_RE's doc comment in tool-usage.tsx).
  const isSecret = Boolean(payload.secret) || SECRET_QUESTION_RE.test(question)

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
                disabled={disabled}
                onClick={() => toggleOption(option.label)}
                className={cn(
                  "flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2 text-left transition-colors hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-50",
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
              disabled={disabled || selected.size === 0}
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
          disabled={disabled}
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
        <Button
          size="sm"
          onClick={submitFreeText}
          disabled={disabled || !freeText.trim()}
        >
          Send
        </Button>
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onRespond("(skipped)")}
        className="mt-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        Skip question
      </button>
    </div>
  )
}
