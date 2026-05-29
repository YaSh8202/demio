// ── Prompt Question Card ─────────────────────────────────────────────────────
//
// Codex/opencode-style question card that REPLACES the prompt input when the
// agent's `ask_user` tool is awaiting an answer. Subscribes to the
// `questions:onAsked` / `questions:onResolved` IPC events and rehydrates from
// `apis.questions.list()` on mount so a renderer refresh during a pending
// question still surfaces the prompt.
//
// Keyboard:
//   ↑ / ↓        — move selection between options
//   1–9          — quick-select an option (single-select only)
//   Enter        — submit current question (advance to next, or finalize)
//   Esc          — dismiss (rejects the pending question)

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apis, events } from "@/types/electron-api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// ── Local types (mirror electron/agent/questions.ts) ─────────────────────────

interface AskQuestionOption {
  label: string
  description: string
}

interface AskQuestionInfo {
  question: string
  header: string
  options: AskQuestionOption[]
  multiple?: boolean
  custom?: boolean
  secret?: boolean
}

interface AskRequest {
  id: string
  questions: AskQuestionInfo[]
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Returns the currently-pending `ask_user` request, or null. Subscribes to
 * the lifecycle events and rehydrates from `apis.questions.list()` on mount.
 */
export function useActiveQuestion(): AskRequest | null {
  const [pending, setPending] = useState<AskRequest | null>(null)

  useEffect(() => {
    if (!apis) return
    let cancelled = false
    void apis.questions.list().then((list) => {
      if (cancelled) return
      // If multiple are pending, surface the oldest first (insertion order is
      // preserved by Map iteration, which `listPending` mirrors).
      setPending(list?.[0] ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!events) return
    const unsubAsked = events.questions.onAsked((req: AskRequest) => {
      setPending((prev) => prev ?? req)
    })
    const unsubResolved = events.questions.onResolved((id: string) => {
      setPending((prev) => {
        if (!prev || prev.id !== id) return prev
        return null
      })
      // After a resolve, see if another question is queued.
      if (apis) {
        void apis.questions.list().then((list) => {
          if (list && list.length > 0) {
            setPending((current) => current ?? list[0])
          }
        })
      }
    })
    return () => {
      unsubAsked?.()
      unsubResolved?.()
    }
  }, [])

  return pending
}

// ── Component ────────────────────────────────────────────────────────────────

export function PromptQuestionCard({ request }: { request: AskRequest }) {
  const totalQuestions = request.questions.length
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<string[][]>(() =>
    request.questions.map(() => [])
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [customText, setCustomText] = useState("")
  const containerRef = useRef<HTMLDivElement | null>(null)
  const customInputRef = useRef<HTMLInputElement | null>(null)

  // Note: ThreadShell keys this component by `request.id`, so a new pending
  // request remounts (no explicit reset effect needed). Step transitions
  // reset selection/custom text inline inside `submit`.

  const currentQuestion = request.questions[step]
  const isLastStep = step === totalQuestions - 1
  const customEnabled = currentQuestion.custom !== false
  const isSecret = currentQuestion.secret === true
  const optionCount = currentQuestion.options.length
  const customRowIndex = optionCount // virtual row index for the custom input
  const showCustomRow = customEnabled || isSecret || optionCount === 0
  const totalRows = optionCount + (showCustomRow ? 1 : 0)

  // ── Focus management ───────────────────────────────────────────────────
  // Reset of selectedIndex / customText is handled inline inside `submit`
  // when advancing the step; the effect below only owns DOM focus.
  useEffect(() => {
    if (optionCount === 0) {
      const t = window.setTimeout(() => customInputRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
    containerRef.current?.focus()
  }, [step, optionCount])

  // ── Submit / dismiss ───────────────────────────────────────────────────
  const submit = useCallback(
    (finalAnswerForCurrent: string[]) => {
      const nextAnswers = answers.slice()
      nextAnswers[step] = finalAnswerForCurrent
      if (!isLastStep) {
        setAnswers(nextAnswers)
        setSelectedIndex(0)
        setCustomText("")
        setStep((s) => s + 1)
        return
      }
      if (apis) {
        void apis.questions.reply(request.id, nextAnswers)
      }
    },
    [answers, step, isLastStep, request.id]
  )

  const dismiss = useCallback(() => {
    if (apis) {
      void apis.questions.reject(request.id)
    }
  }, [request.id])

  // ── Build the current answer from local selection state ────────────────
  const buildAnswerFromSelection = useCallback((): string[] | null => {
    // Multi-select: gather currently-checked labels.
    if (currentQuestion.multiple) {
      const checked = answers[step]
      // Append the custom text if the user filled it.
      const withCustom = customText.trim()
        ? [...checked, customText.trim()]
        : checked
      if (withCustom.length === 0) return null
      return withCustom
    }

    // Single-select: prefer custom text if focused/filled or no option focused.
    if (selectedIndex === customRowIndex && showCustomRow) {
      const text = customText.trim()
      if (!text) return null
      return [text]
    }

    const option = currentQuestion.options[selectedIndex]
    if (!option) {
      const text = customText.trim()
      if (!text) return null
      return [text]
    }
    return [option.label]
  }, [
    currentQuestion,
    selectedIndex,
    customText,
    answers,
    step,
    customRowIndex,
    showCustomRow,
  ])

  // ── Keyboard handler (card-level) ──────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault()
        dismiss()
        return
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        if (currentQuestion.multiple) {
          const built = buildAnswerFromSelection()
          if (built) submit(built)
          return
        }
        const built = buildAnswerFromSelection()
        if (built) submit(built)
        return
      }

      // Arrow navigation works only when there are options.
      if (totalRows <= 1) return
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % totalRows)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + totalRows) % totalRows)
        return
      }

      // Number shortcut for single-select with options.
      if (!currentQuestion.multiple && /^[1-9]$/.test(e.key) && optionCount > 0) {
        const idx = parseInt(e.key, 10) - 1
        if (idx < optionCount) {
          e.preventDefault()
          submit([currentQuestion.options[idx].label])
        }
      }
    },
    [
      dismiss,
      submit,
      buildAnswerFromSelection,
      currentQuestion,
      totalRows,
      optionCount,
    ]
  )

  // ── Multi-select toggle ────────────────────────────────────────────────
  const toggleOption = useCallback(
    (label: string) => {
      if (!currentQuestion.multiple) {
        submit([label])
        return
      }
      setAnswers((prev) => {
        const next = prev.slice()
        const current = next[step] ?? []
        next[step] = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        return next
      })
    },
    [currentQuestion.multiple, step, submit]
  )

  const checkedSet = useMemo(
    () => new Set(answers[step] ?? []),
    [answers, step]
  )

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-surface text-surface-foreground shadow-sm outline-none focus:ring-0"
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <p className="text-sm leading-5 font-medium text-foreground">
            {currentQuestion.question}
          </p>
          <p className="mt-0.5 text-[11px] tracking-wide text-muted-foreground uppercase">
            {currentQuestion.header}
            {totalQuestions > 1 && ` · ${step + 1} of ${totalQuestions}`}
            {currentQuestion.multiple && " · multi-select"}
            {isSecret && " · masked"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-col">
        {currentQuestion.options.map((option, idx) => {
          const isFocused = selectedIndex === idx
          const isChecked = checkedSet.has(option.label)
          return (
            <button
              key={`${option.label}-${idx}`}
              type="button"
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => toggleOption(option.label)}
              className={cn(
                "group flex items-start gap-3 px-4 py-2.5 text-left transition-colors",
                isFocused
                  ? "bg-muted/60 text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 w-4 shrink-0 text-right text-[12px] font-mono",
                  isFocused ? "text-foreground" : "text-muted-foreground/70"
                )}
              >
                {idx + 1}.
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block text-[13px] leading-5 font-medium",
                    isFocused ? "text-foreground" : "text-foreground/90"
                  )}
                >
                  {option.label}
                </span>
                {option.description && (
                  <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
              {currentQuestion.multiple && (
                <span
                  className={cn(
                    "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-border text-[10px]",
                    isChecked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-transparent"
                  )}
                  aria-hidden
                >
                  {isChecked ? "✓" : ""}
                </span>
              )}
            </button>
          )
        })}

        {showCustomRow && (
          <div
            className={cn(
              "flex items-start gap-3 px-4 py-2.5 transition-colors",
              selectedIndex === customRowIndex && optionCount > 0
                ? "bg-muted/60"
                : ""
            )}
            onMouseEnter={() =>
              optionCount > 0 ? setSelectedIndex(customRowIndex) : undefined
            }
          >
            {optionCount > 0 && (
              <span
                className={cn(
                  "mt-1.5 w-4 shrink-0 text-right text-[12px] font-mono",
                  selectedIndex === customRowIndex
                    ? "text-foreground"
                    : "text-muted-foreground/70"
                )}
              >
                {optionCount + 1}.
              </span>
            )}
            <input
              ref={customInputRef}
              type={isSecret ? "password" : "text"}
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onFocus={() =>
                optionCount > 0 ? setSelectedIndex(customRowIndex) : undefined
              }
              placeholder={
                isSecret
                  ? optionCount > 0
                    ? "Or enter a secret value..."
                    : "Enter the secret value..."
                  : optionCount > 0
                    ? "Or type your own answer..."
                    : "Type your answer..."
              }
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[13px] leading-5 outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        <p className="text-[11px] text-muted-foreground">
          {currentQuestion.multiple
            ? "Toggle options with click. "
            : optionCount > 1
              ? "Use ↑ ↓ to navigate, 1–9 to quick-select. "
              : ""}
          Press <kbd className="rounded bg-muted px-1 font-mono">↵</kbd> to{" "}
          {isLastStep ? "submit" : "continue"}.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Dismiss
            <kbd className="rounded bg-muted px-1 font-mono">esc</kbd>
          </button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              const built = buildAnswerFromSelection()
              if (built) submit(built)
            }}
            disabled={(() => {
              const built = buildAnswerFromSelection()
              return !built
            })()}
          >
            {isLastStep ? "Submit" : "Next"}
            <kbd className="ml-1 rounded bg-primary/20 px-1 font-mono text-[10px]">
              ↵
            </kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}
